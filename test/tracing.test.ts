import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Configuration } from "../src/configuration.js";
import * as forgeOpsTracker from "../src/index.js";
import { Trace, TracePayload } from "../src/tracing.js";

const originalFetch = globalThis.fetch;

class FakeXMLHttpRequest {
  status = 0;
  headers: Record<string, string> = {};
  private listeners: (() => void)[] = [];
  open(_method: string, _url: string | URL, _async?: boolean, _username?: string | null, _password?: string | null): void {}
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(_body?: unknown): void {}
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener);
  }
  finish(status: number): void {
    this.status = status;
    this.listeners.forEach((l) => l());
  }
}

function xhr(method: string, url: string, headers: Record<string, string> = {}): FakeXMLHttpRequest {
  const request = new FakeXMLHttpRequest();
  request.open(method, url);
  for (const [name, value] of Object.entries(headers)) {
    request.setRequestHeader(name, value);
  }
  request.send();
  return request;
}

interface Delivered {
  url: string;
  body: TracePayload;
}

function stubFetch(): Delivered[] {
  const calls: Delivered[] = [];
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(init!.body as string) });
    return new Response(null, { status: 202 });
  });
  return calls;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configure(overrides: Record<string, unknown> = {}): void {
  forgeOpsTracker.init({
    dsn: "https://key@tracker.example.com/api/v1/events",
    environment: "production",
    release: "a1b2c3d",
    enabledEnvironments: new Set(["production"]),
    installGlobalHandlers: false,
    breadcrumbs: false,
    trackPerformance: false,
    traceCaptureThresholdMs: 10,
    ...overrides,
  });
}

function span(payload: TracePayload, name: string) {
  return payload.spans.find((s) => s.name === name)!;
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXMLHttpRequest;
});

afterEach(() => {
  forgeOpsTracker._resetForTesting();
  globalThis.fetch = originalFetch;
  delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
});

describe("distributed tracing", () => {
  it("delivers a slow trace to /spans with nested spans and the wire shape", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("HomeScreen.load", async (t) => {
      await t.span(
        "fetch feed",
        async (scope) => {
          scope.recordSpan("SELECT feed", { kind: "database", startedAt: 1_700_000_000_123, durationMs: 3 });
          await sleep(30);
        },
        { kind: "http", data: { status: 200 } },
      );
      t.recordSpan("sibling", { startedAt: new Date(), durationMs: 1 });
    });
    await forgeOpsTracker.flushSpans();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://tracker.example.com/api/v1/spans");
    const payload = calls[0]!.body;
    expect(payload.trace_id).toMatch(/^[0-9a-f]{32}$/);
    const root = span(payload, "HomeScreen.load");
    const fetchSpan = span(payload, "fetch feed");
    expect(root.parent_span_id).toBeNull();
    expect(root.kind).toBe("controller");
    expect(root.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(fetchSpan.parent_span_id).toBe(root.span_id);
    expect(span(payload, "SELECT feed").parent_span_id).toBe(fetchSpan.span_id);
    expect(span(payload, "sibling").parent_span_id).toBe(root.span_id);
    expect(span(payload, "SELECT feed").started_at).toBe("2023-11-14T22:13:20.123Z");
    expect(fetchSpan.environment).toBe("production");
    expect(fetchSpan.release).toBe("a1b2c3d");
    expect(fetchSpan.data).toEqual({ status: 200 });
  });

  it("nests correctly across awaits and for children started in parallel", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async (t) => {
      await t.span("outer", async (outer) => {
        await Promise.all([outer.span("a", () => sleep(20)), outer.span("b", () => sleep(5))]);
      });
      await t.span("after", () => sleep(5));
    });
    await forgeOpsTracker.flushSpans();

    const payload = calls[0]!.body;
    expect(span(payload, "a").parent_span_id).toBe(span(payload, "outer").span_id);
    expect(span(payload, "b").parent_span_id).toBe(span(payload, "outer").span_id);
    expect(span(payload, "after").parent_span_id).toBe(span(payload, "t").span_id);
  });

  it("sends an unknown kind as other, since the server would reject the whole trace", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async (t) => {
      t.recordSpan("q", { kind: "db", startedAt: Date.now(), durationMs: 1 });
      t.recordSpan("r", { kind: "database", startedAt: Date.now(), durationMs: 1 });
      await sleep(30);
    });
    await forgeOpsTracker.flushSpans();

    expect(span(calls[0]!.body, "q").kind).toBe("other");
    expect(span(calls[0]!.body, "r").kind).toBe("database");
  });

  it("sends a database span's statement masked as db.statement, with db.system", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async (t) => {
      await t.span("Load orders", async () => sleep(30), {
        kind: "database",
        statement: "SELECT * FROM orders WHERE email = 'a@b.co' AND total > 4200",
        dbSystem: "SQLite",
        data: { rows: 3 },
      });
      t.recordSpan("Count", {
        kind: "database",
        startedAt: Date.now(),
        durationMs: 1,
        data: { "db.statement": "SELECT count(*) FROM carts WHERE token = 'secret-token'" },
      });
      t.recordSpan("Not db", { kind: "service", statement: "SELECT 'x'", startedAt: Date.now(), durationMs: 1 });
    });
    await forgeOpsTracker.flushSpans();

    const payload = calls[0]!.body;
    expect(span(payload, "Load orders").data).toEqual({
      rows: 3,
      "db.statement": "SELECT * FROM orders WHERE email = ? AND total > ?",
      "db.system": "sqlite",
    });
    expect(span(payload, "Count").data).toEqual({ "db.statement": "SELECT count(*) FROM carts WHERE token = ?" });
    expect(span(payload, "Not db").data).toEqual({});
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain("a@b.co");
    expect(wire).not.toContain("secret-token");
  });

  it("masks \"double quoted\" values on a MySQL or MariaDB database span only", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async (t) => {
      t.recordSpan("MySQL", { kind: "database", statement: 'SELECT id FROM t WHERE token = "abc123secret"', dbSystem: "MySQL", startedAt: Date.now(), durationMs: 1 });
      t.recordSpan("MariaDB", {
        kind: "database",
        data: { "db.system": "mariadb", "db.statement": 'SELECT id FROM t WHERE name = "jane"' },
        startedAt: Date.now(),
        durationMs: 1,
      });
      t.recordSpan("Postgres", { kind: "database", statement: 'SELECT "user id" FROM t', dbSystem: "postgresql", startedAt: Date.now(), durationMs: 1 });
      await sleep(30);
    });
    await forgeOpsTracker.flushSpans();

    const payload = calls[0]!.body;
    expect(span(payload, "MySQL").data).toEqual({ "db.statement": "SELECT id FROM t WHERE token = ?", "db.system": "mysql" });
    expect(span(payload, "MariaDB").data).toEqual({ "db.statement": "SELECT id FROM t WHERE name = ?", "db.system": "mariadb" });
    expect(span(payload, "Postgres").data).toEqual({ "db.statement": 'SELECT "user id" FROM t', "db.system": "postgresql" });
  });

  it("truncates a long database statement to 4000 characters", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async (t) => {
      t.recordSpan("big", { kind: "database", statement: `SELECT ${"a, ".repeat(3000)}b FROM t`, startedAt: Date.now(), durationMs: 1 });
      await sleep(30);
    });
    await forgeOpsTracker.flushSpans();

    const statement = span(calls[0]!.body, "big").data["db.statement"] as string;
    expect(statement.length).toBe(4003);
    expect(statement.endsWith("...")).toBe(true);
  });

  it("records a span and sends the trace even when the callback throws or rejects, rethrowing unchanged", async () => {
    const calls = stubFetch();
    configure();

    const failure = new Error("boom");
    await expect(
      forgeOpsTracker.trace("t", (t) =>
        t.span("bad", async () => {
          await sleep(30);
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    await forgeOpsTracker.flushSpans();
    expect(span(calls[0]!.body, "bad")).toBeDefined();

    expect(() =>
      forgeOpsTracker.trace("sync", (t) => {
        t.span("bad sync", () => {
          throw failure;
        });
      }),
    ).toThrow(failure);
  });

  it("returns the callback's value, synchronous or not", async () => {
    stubFetch();
    configure();
    expect(forgeOpsTracker.trace("t", (t) => t.span("s", () => 7))).toBe(7);
    expect(await forgeOpsTracker.trace("t", async (t) => t.span("s", async () => 8))).toBe(8);
  });

  it("sends nothing for a fast trace", async () => {
    const calls = stubFetch();
    configure({ traceCaptureThresholdMs: 60_000 });

    forgeOpsTracker.trace("fast", (t) => t.recordSpan("q", { kind: "database", startedAt: Date.now(), durationMs: 1 }));
    await forgeOpsTracker.flushSpans();

    expect(calls).toHaveLength(0);
  });

  it("returns a disabled trace when tracing is off or reporting is not enabled, and still runs the callback", async () => {
    const calls = stubFetch();
    configure({ trackTracing: false });
    let ran = false;
    await forgeOpsTracker.trace("x", async (t) => {
      expect(t.enabled).toBe(false);
      ran = await t.span("y", async () => {
        await sleep(30);
        return true;
      });
      t.recordSpan("z", { startedAt: Date.now(), durationMs: 1 });
    });
    expect(ran).toBe(true);

    forgeOpsTracker._resetForTesting();
    configure({ environment: "development" });
    expect(forgeOpsTracker.startTrace("x").enabled).toBe(false);
    await forgeOpsTracker.flushSpans();

    expect(calls).toHaveLength(0);
  });

  it("finish is idempotent and spans after it are dropped", async () => {
    const calls = stubFetch();
    configure();

    const t = forgeOpsTracker.startTrace("t");
    await sleep(30);
    t.finish();
    t.finish();
    t.recordSpan("late", { startedAt: Date.now(), durationMs: 1 });
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.spans.map((s) => s.name)).toEqual(["t"]);
  });

  it("records a network request made while exactly one trace is open as an http span named METHOD host, never the path", async () => {
    const calls = stubFetch();
    configure();

    await forgeOpsTracker.trace("t", async () => {
      xhr("GET", "https://api.example.com/users/42?token=secret").finish(404);
      await sleep(30);
    });
    await forgeOpsTracker.flushSpans();

    const http = calls[0]!.body.spans.find((s) => s.kind === "http")!;
    expect(http.name).toBe("GET api.example.com");
    expect(http.data).toEqual({ status: 404 });
    expect(http.parent_span_id).toBe(span(calls[0]!.body, "t").span_id);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("secret");
  });

  it("leaves a network request out when two traces are open, and never records this client's own requests", async () => {
    const calls = stubFetch();
    configure();

    const a = forgeOpsTracker.startTrace("a");
    const b = forgeOpsTracker.startTrace("b");
    xhr("GET", "https://api.example.com/ambiguous").finish(200);
    b.finish();
    xhr("POST", "https://tracker.example.com/api/v1/spans").finish(202);
    xhr("GET", "https://api.example.com/only-a").finish(200);
    await sleep(30);
    a.finish();
    await forgeOpsTracker.flushSpans();

    const names = calls.flatMap((c) => c.body.spans.map((s) => s.name));
    expect(names).toContain("GET api.example.com");
    expect(calls.flatMap((c) => c.body.spans).filter((s) => s.kind === "http")).toHaveLength(1);
    expect(names).not.toContain("POST tracker.example.com");
  });

  it("holds at most 500 spans including the root", () => {
    const config = new Configuration();
    config.dsn = "https://key@tracker.example.com/api/v1/events";
    config.traceCaptureThresholdMs = 0;
    let delivered: TracePayload | undefined;
    const t = new Trace("root", config, (payload) => {
      delivered = payload;
    });
    for (let i = 0; i < 700; i++) {
      t.recordSpan("q", { kind: "database", startedAt: Date.now(), durationMs: 1 });
    }
    t.finish();

    expect(delivered!.spans).toHaveLength(500);
  });

  it("spansUri swaps the trailing events segment", () => {
    const config = new Configuration();
    config.dsn = "https://key@tracker.example.com/api/v1/events";
    expect(config.spansUri()).toBe("https://tracker.example.com/api/v1/spans");
  });
});

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A stand-in for React Native's global fetch (whatwg-fetch): opens, sets headers on, and sends an
 * XMLHttpRequest synchronously inside the call, then resolves once it completes, so a request goes
 * through the same patch the SDK installs on a device. Records every request, this client's own
 * deliveries included.
 */
function stubRnFetch(status = 200): SentRequest[] {
  const sent: SentRequest[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const request = new FakeXMLHttpRequest();
    request.open(init?.method ?? "GET", url);
    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value);
    }
    request.send();
    sent.push({ url, headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Promise<Response>((resolve) =>
      setTimeout(() => {
        request.finish(status);
        resolve(new Response(null, { status }));
      }, 1),
    );
  }) as typeof fetch;
  return sent;
}

function traces(sent: SentRequest[]): TracePayload[] {
  return sent.filter((r) => r.url.endsWith("/spans")).map((r) => r.body as TracePayload);
}

describe("trace propagation (W3C trace context)", () => {
  it("uses W3C ids: a 32 hex trace id and 16 hex span ids, never all zeros", () => {
    stubFetch();
    configure();
    const t = forgeOpsTracker.startTrace("t");
    expect(t.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(t.traceId).not.toMatch(/^0+$/);
    const [, , spanId] = TRACEPARENT.exec(t.httpSpan("GET", "https://api.example.com/").headers.traceparent!)!;
    expect(spanId).not.toMatch(/^0+$/);
    t.finish();
  });

  it("adds traceparent to a request made inside a trace, naming the recorded http span as its parent", async () => {
    const calls = stubFetch();
    configure();

    const t = forgeOpsTracker.startTrace("Checkout");
    const request = xhr("POST", "https://api.example.com/orders");
    request.finish(201);
    await sleep(30);
    t.finish();
    await forgeOpsTracker.flushSpans();

    const [, traceId, parentId] = TRACEPARENT.exec(request.headers.traceparent!)!;
    const payload = calls[0]!.body;
    expect(traceId).toBe(t.traceId);
    expect(payload.trace_id).toBe(t.traceId);
    const http = payload.spans.find((s) => s.kind === "http")!;
    expect(http.span_id).toBe(parentId);
    expect(http.parent_span_id).toBe(span(payload, "Checkout").span_id);
  });

  it("adds no header outside a trace, with two traces open, or to this client's own requests", () => {
    stubFetch();
    configure();

    expect(xhr("GET", "https://api.example.com/before").headers).toEqual({});

    const a = forgeOpsTracker.startTrace("a");
    const b = forgeOpsTracker.startTrace("b");
    expect(xhr("GET", "https://api.example.com/ambiguous").headers).toEqual({});
    b.finish();
    expect(xhr("POST", "https://tracker.example.com/api/v1/events").headers).toEqual({});
    expect(xhr("GET", "https://api.example.com/only-a").headers.traceparent).toMatch(TRACEPARENT);
    a.finish();

    expect(xhr("GET", "https://api.example.com/after").headers).toEqual({});
  });

  it("never overwrites a traceparent the app set, and still records the request", async () => {
    const calls = stubFetch();
    configure();
    const own = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    const t = forgeOpsTracker.startTrace("t");
    const request = xhr("GET", "https://api.example.com/x", { traceparent: own });
    request.finish(200);
    await sleep(30);
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(request.headers.traceparent).toBe(own);
    expect(calls[0]!.body.spans.filter((s) => s.kind === "http")).toHaveLength(1);
  });

  it("adds no header with propagateTraces off, and still records the span", async () => {
    const calls = stubFetch();
    configure({ propagateTraces: false });

    const t = forgeOpsTracker.startTrace("t");
    const request = xhr("GET", "https://api.example.com/x");
    request.finish(200);
    await sleep(30);
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(request.headers).toEqual({});
    expect(calls[0]!.body.spans.filter((s) => s.kind === "http")).toHaveLength(1);
  });

  it("only adds the header to tracePropagationTargets hosts: a string on a dot boundary, or a RegExp", () => {
    stubFetch();
    configure({ tracePropagationTargets: ["example.com", /^10\.0\./] });

    const t = forgeOpsTracker.startTrace("t");
    expect(xhr("GET", "https://example.com/").headers.traceparent).toMatch(TRACEPARENT);
    expect(xhr("GET", "https://api.EXAMPLE.com:8443/").headers.traceparent).toMatch(TRACEPARENT);
    expect(xhr("GET", "http://10.0.2.2:3000/").headers.traceparent).toMatch(TRACEPARENT);
    expect(xhr("GET", "https://badexample.com/").headers).toEqual({});
    expect(xhr("GET", "https://example.com.evil.net/").headers).toEqual({});
    expect(xhr("GET", "https://thirdparty.io/").headers).toEqual({});
    t.finish();
  });

  it("httpSpan returns the header for a request you make yourself and records it under the scope it came from", async () => {
    const calls = stubFetch();
    configure();

    let headers: Readonly<Record<string, string>> = {};
    await forgeOpsTracker.trace("t", async (t) => {
      await t.span("submit", async (scope) => {
        const call = scope.httpSpan("post", "https://api.example.com/orders?coupon=secret");
        headers = call.headers;
        // Sent through XMLHttpRequest too, the way axios would: recorded once, by the explicit span.
        const request = xhr("POST", "https://api.example.com/orders", { ...call.headers });
        await sleep(20);
        request.finish(500);
        call.end(500);
        call.end(200);
      });
    });
    await forgeOpsTracker.flushSpans();

    const payload = calls[0]!.body;
    const http = payload.spans.filter((s) => s.kind === "http");
    expect(http).toHaveLength(1);
    expect(http[0]!.name).toBe("POST api.example.com");
    expect(http[0]!.data).toEqual({ status: 500 });
    expect(http[0]!.parent_span_id).toBe(span(payload, "submit").span_id);
    expect(headers.traceparent).toBe(`00-${payload.trace_id}-${http[0]!.span_id}-01`);
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("httpSpan honors tracePropagationTargets, and a disabled or finished trace hands out no header", () => {
    stubFetch();
    configure({ tracePropagationTargets: ["example.com"] });
    const t = forgeOpsTracker.startTrace("t");
    expect(t.httpSpan("GET", "https://thirdparty.io/").headers).toEqual({});
    t.finish();
    expect(t.httpSpan("GET", "https://api.example.com/").headers).toEqual({});

    forgeOpsTracker._resetForTesting();
    configure({ trackTracing: false });
    const disabled = forgeOpsTracker.startTrace("t");
    expect(disabled.httpSpan("GET", "https://api.example.com/").headers).toEqual({});
    expect(xhr("GET", "https://api.example.com/").headers).toEqual({});
  });

  it("t.fetch sends the header through React Native's fetch and records one http span with the status", async () => {
    const sent = stubRnFetch(404);
    configure();

    const t = forgeOpsTracker.startTrace("Checkout");
    const response = await t.fetch("https://api.example.com/cart", { method: "PUT", headers: { "Content-Type": "application/json" } });
    await sleep(20);
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(response.status).toBe(404);
    const call = sent.find((r) => r.url === "https://api.example.com/cart")!;
    expect(call.headers["content-type"]).toBe("application/json");
    const [, traceId, parentId] = TRACEPARENT.exec(call.headers.traceparent!)!;
    const payload = traces(sent)[0]!;
    expect(traceId).toBe(payload.trace_id);
    const http = payload.spans.filter((s) => s.kind === "http");
    expect(http).toHaveLength(1);
    expect(http[0]!).toMatchObject({ span_id: parentId, name: "PUT api.example.com", data: { status: 404 } });
    // This client's own delivery to /spans went through the same fetch and got no header.
    expect(sent.find((r) => r.url.endsWith("/spans"))!.headers.traceparent).toBeUndefined();
  });

  it("t.fetch keeps a traceparent already in init.headers, records once even with no header sent, and rethrows a failure", async () => {
    const sent = stubRnFetch();
    configure({ tracePropagationTargets: ["example.com"] });
    const own = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    const t = forgeOpsTracker.startTrace("t");
    await t.fetch("https://api.example.com/a", { headers: { traceparent: own } });
    await t.fetch("https://thirdparty.io/b");
    await sleep(20);
    t.finish();
    await forgeOpsTracker.flushSpans();

    expect(sent.find((r) => r.url.endsWith("/a"))!.headers.traceparent).toBe(own);
    expect(sent.find((r) => r.url.endsWith("/b"))!.headers.traceparent).toBeUndefined();
    const http = traces(sent)[0]!.spans.filter((s) => s.kind === "http");
    expect(http.map((s) => s.name).sort()).toEqual(["GET api.example.com", "GET thirdparty.io"]);

    const failure = new TypeError("Network request failed");
    globalThis.fetch = vi.fn(async () => {
      throw failure;
    });
    const recorded: TracePayload[] = [];
    const config = new Configuration();
    config.traceCaptureThresholdMs = 0;
    const direct = new Trace("t", config, (payload) => recorded.push(payload));
    await expect(direct.fetch("https://api.example.com/")).rejects.toBe(failure);
    direct.finish();
    expect(recorded[0]!.spans.find((s) => s.kind === "http")!.data).toEqual({});
  });

  it("a disabled trace's fetch is the global fetch, untouched", async () => {
    const sent = stubRnFetch();
    configure({ trackTracing: false });

    await forgeOpsTracker.startTrace("t").fetch("https://api.example.com/", { headers: { a: "1" } });

    expect(sent[0]!.headers).toEqual({ a: "1" });
  });
});

describe("errors captured during a trace", () => {
  function events(sent: SentRequest[]): Record<string, unknown>[] {
    return sent.filter((r) => r.url.endsWith("/events")).map((r) => r.body as Record<string, unknown>);
  }

  async function waitForEvents(sent: SentRequest[], count: number): Promise<void> {
    for (let i = 0; i < 100 && events(sent).length < count; i++) {
      await sleep(5);
    }
  }

  it("carry the open trace's id as a top-level trace_id", async () => {
    const sent = stubRnFetch();
    configure();

    const t = forgeOpsTracker.startTrace("Checkout");
    forgeOpsTracker.captureException(new Error("payment declined"));
    t.finish();
    await waitForEvents(sent, 1);

    expect(events(sent)[0]!.trace_id).toBe(t.traceId);
  });

  it("carry no trace_id outside a trace, with two traces open, or when tracing is off", async () => {
    const sent = stubRnFetch();
    configure();

    forgeOpsTracker.captureException(new Error("outside"));
    const a = forgeOpsTracker.startTrace("a");
    const b = forgeOpsTracker.startTrace("b");
    forgeOpsTracker.captureException(new Error("ambiguous"));
    a.finish();
    b.finish();
    await waitForEvents(sent, 2);

    forgeOpsTracker._resetForTesting();
    configure({ trackTracing: false });
    const disabled = forgeOpsTracker.startTrace("off");
    forgeOpsTracker.captureException(new Error("tracing off"));
    disabled.finish();
    await waitForEvents(sent, 3);

    expect(events(sent)).toHaveLength(3);
    for (const event of events(sent)) {
      expect(event).not.toHaveProperty("trace_id");
    }
  });
});
