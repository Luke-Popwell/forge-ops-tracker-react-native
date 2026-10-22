import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as forgeOpsTracker from "../src/index.js";

const originalFetch = globalThis.fetch;

function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for condition"));
        return;
      }
      setTimeout(check, 5);
    };
    check();
  });
}

interface CapturedRequest {
  uri: RequestInfo | URL;
  init?: RequestInit;
}

function mockFetchCapturing(): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  globalThis.fetch = vi.fn(async (uri: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ uri, init });
    return new Response(null, { status: 202 });
  });
  return requests;
}

// A minimal stand-in for React Native's own global: see src/types/react-native-globals.d.ts.
// Not present at all under plain Node/vitest unless a test installs it itself, the same way it's
// genuinely absent in any non-RN environment this package might accidentally run in (which is
// exactly what the "does nothing when ErrorUtils is undefined" test below exercises for real,
// not simulated).
function installFakeErrorUtils(): { getGlobalHandler: () => unknown; setGlobalHandler: ReturnType<typeof vi.fn> } {
  let handler: ((error: unknown, isFatal?: boolean) => void) | null = null;
  const fake = {
    getGlobalHandler: () => handler,
    setGlobalHandler: vi.fn((h: (error: unknown, isFatal?: boolean) => void) => {
      handler = h;
    }),
  };
  (globalThis as unknown as { ErrorUtils: unknown }).ErrorUtils = fake;
  return fake;
}

beforeEach(() => {
  forgeOpsTracker._resetForTesting();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
  forgeOpsTracker._resetForTesting();
});

describe("index", () => {
  it("init configures and returns the configuration", () => {
    const config = forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      release: "abc123",
    });

    expect(config.dsn).toBe("https://key@tracker.example.com/api/v1/events");
    expect(config.release).toBe("abc123");
  });

  it("init rejects an unknown configuration property", () => {
    expect(() => {
      forgeOpsTracker.init({ notARealSetting: true } as never);
    }).toThrow(TypeError);
  });

  it("captureException delivers through the full stack", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
      installGlobalHandlers: false,
    });

    try {
      throw new Error("boom");
    } catch (error) {
      forgeOpsTracker.captureException(error as Error);
    }

    await waitUntil(() => requests.length === 1);
    expect((requests[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer key");
  });

  it("setUser attaches the user to a later captureException call", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
      installGlobalHandlers: false,
    });

    forgeOpsTracker.setUser({ id: 42, email: "alice@example.com" });
    forgeOpsTracker.captureException(new Error("boom"));

    await waitUntil(() => requests.length === 1);
    const body = requests[0]!.init!.body as string;
    expect(body).toContain("alice@example.com");
  });

  it("an explicit user argument overrides whatever setUser last set", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
      installGlobalHandlers: false,
    });

    forgeOpsTracker.setUser({ id: 42 });
    forgeOpsTracker.captureException(new Error("boom"), {}, { id: 99 });

    await waitUntil(() => requests.length === 1);
    const body = requests[0]!.init!.body as string;
    expect(body).toContain('"id":99');
  });

  it("_resetForTesting clears the current user", async () => {
    forgeOpsTracker.setUser({ id: 42 });
    forgeOpsTracker._resetForTesting();

    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
      installGlobalHandlers: false,
    });
    forgeOpsTracker.captureException(new Error("boom"));

    await waitUntil(() => requests.length === 1);
    const body = requests[0]!.init!.body as string;
    expect(body).not.toContain('"user"');
  });

  it("ErrorUtils handler reports an uncaught exception then chains to the previous handler", async () => {
    const errorUtils = installFakeErrorUtils();
    const previousCalls: unknown[] = [];
    errorUtils.setGlobalHandler((error: unknown) => previousCalls.push(error)); // simulate RN's own pre-installed default

    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
    });

    const installedHandler = errorUtils.setGlobalHandler.mock.calls[1]![0] as (error: unknown, isFatal?: boolean) => void;
    installedHandler(new Error("uncaught"), true);

    await waitUntil(() => requests.length === 1);
    expect((requests[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer key");
    expect(previousCalls).toHaveLength(1);
  });

  it("installGlobalHandlers: false leaves ErrorUtils untouched", () => {
    const errorUtils = installFakeErrorUtils();

    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      installGlobalHandlers: false,
    });

    expect(errorUtils.setGlobalHandler).not.toHaveBeenCalled();
  });

  it("does nothing (and does not throw) when ErrorUtils is undefined", () => {
    // No installFakeErrorUtils() call here: this genuinely runs with no ErrorUtils global at
    // all, the real situation for this package outside a React Native runtime.
    expect(() => {
      forgeOpsTracker.init({ dsn: "https://key@tracker.example.com/api/v1/events" });
    }).not.toThrow();
  });

  it("addBreadcrumb attaches the trail to a later captureException call", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
      installGlobalHandlers: false,
      breadcrumbs: false,
    });

    forgeOpsTracker.addBreadcrumb({ category: "payment", message: "charging card", data: { orderId: 42 } });
    forgeOpsTracker.captureException(new Error("boom"));

    await waitUntil(() => requests.length === 1);
    const body = JSON.parse(requests[0]!.init!.body as string);
    expect(body.breadcrumbs).toHaveLength(1);
    expect(body.breadcrumbs[0]).toMatchObject({ category: "payment", message: "charging card", level: "info", data: { orderId: 42 } });
    expect(body.breadcrumbs[0].timestamp).toMatch(/Z$/);
  });

  it("addBreadcrumb defaults category to custom and level to info", () => {
    forgeOpsTracker.init({ installGlobalHandlers: false, breadcrumbs: false });

    forgeOpsTracker.addBreadcrumb({ message: "something happened" });
    forgeOpsTracker.clearBreadcrumbs();
    forgeOpsTracker.addBreadcrumb({ message: "again" });

    // Read back through a real report rather than reaching into module state.
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({ dsn: "https://key@tracker.example.com/api/v1/events", enabledEnvironments: new Set(["production"]), environment: "production" });
    forgeOpsTracker.captureException(new Error("boom"));
    return waitUntil(() => requests.length === 1).then(() => {
      const body = JSON.parse(requests[0]!.init!.body as string);
      expect(body.breadcrumbs).toHaveLength(1);
      expect(body.breadcrumbs[0]).toMatchObject({ category: "custom", level: "info", message: "again" });
    });
  });

  it("clearBreadcrumbs empties the trail, and a report then carries no breadcrumbs key", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
      installGlobalHandlers: false,
      breadcrumbs: false,
    });

    forgeOpsTracker.addBreadcrumb({ message: "first" });
    forgeOpsTracker.clearBreadcrumbs();
    forgeOpsTracker.captureException(new Error("boom"));

    await waitUntil(() => requests.length === 1);
    expect(JSON.parse(requests[0]!.init!.body as string)).not.toHaveProperty("breadcrumbs");
  });

  it("init installs the automatic console source by default, and breadcrumbs: false turns it off", async () => {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
      installGlobalHandlers: false,
    });

    console.info("saw this");
    forgeOpsTracker.captureException(new Error("boom"));

    await waitUntil(() => requests.length === 1);
    const body = JSON.parse(requests[0]!.init!.body as string);
    expect(body.breadcrumbs.map((b: { message: string }) => b.message)).toContain("saw this");

    forgeOpsTracker._resetForTesting();
    const before = console.info;
    forgeOpsTracker.init({ installGlobalHandlers: false, breadcrumbs: false });
    expect(console.info).toBe(before);
  });

  it("_resetForTesting restores console and clears the trail", () => {
    const before = console.info;
    forgeOpsTracker.init({ installGlobalHandlers: false });
    expect(console.info).not.toBe(before);

    forgeOpsTracker._resetForTesting();

    expect(console.info).toBe(before);
  });

  function initForPerformance(overrides: Record<string, unknown> = {}): CapturedRequest[] {
    const requests = mockFetchCapturing();
    forgeOpsTracker.init({
      dsn: "https://key@tracker.example.com/api/v1/events",
      enabledEnvironments: new Set(["production"]),
      environment: "production",
      installGlobalHandlers: false,
      breadcrumbs: false,
      performanceFlushIntervalMs: 3_600_000, // flushed by hand below
      ...overrides,
    });
    return requests;
  }

  it("recordPerformance tallies in-process and flushPerformance delivers one aggregate batch", async () => {
    const requests = initForPerformance();

    forgeOpsTracker.recordPerformance("HomeScreen.load", 10);
    forgeOpsTracker.recordPerformance("HomeScreen.load", 30);
    await forgeOpsTracker.flushPerformance();

    expect(String(requests[0]!.uri)).toBe("https://tracker.example.com/api/v1/performance_samples");
    const sample = JSON.parse(requests[0]!.init!.body as string).samples[0];
    expect(sample).toMatchObject({ transaction_name: "HomeScreen.load", request_count: 2 });
  });

  it("timeTransaction returns a synchronous value and records how long it took", async () => {
    const requests = initForPerformance();

    const value = forgeOpsTracker.timeTransaction("timed", () => 42);
    await forgeOpsTracker.flushPerformance();

    expect(value).toBe(42);
    expect(JSON.parse(requests[0]!.init!.body as string).samples[0].transaction_name).toBe("timed");
  });

  it("timeTransaction records even when the function throws, and rethrows it unchanged", async () => {
    const requests = initForPerformance();

    expect(() =>
      forgeOpsTracker.timeTransaction("timed throws", () => {
        throw new RangeError("inside");
      }),
    ).toThrow(RangeError);
    await forgeOpsTracker.flushPerformance();

    expect(JSON.parse(requests[0]!.init!.body as string).samples[0].transaction_name).toBe("timed throws");
  });

  it("timeTransaction times an async function until it settles, fulfilled or rejected", async () => {
    const requests = initForPerformance();

    const value = await forgeOpsTracker.timeTransaction("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "done";
    });
    await expect(
      forgeOpsTracker.timeTransaction("slow fails", async () => {
        throw new RangeError("later");
      }),
    ).rejects.toThrow(RangeError);
    await forgeOpsTracker.flushPerformance();

    expect(value).toBe("done");
    const samples = JSON.parse(requests[0]!.init!.body as string).samples as { transaction_name: string; duration_sum_ms: number }[];
    const slow = samples.find((s) => s.transaction_name === "slow")!;
    expect(slow.duration_sum_ms).toBeGreaterThanOrEqual(50); // timed across the await, not just the call
    expect(samples.some((s) => s.transaction_name === "slow fails")).toBe(true);
  });

  it("trackPerformance off records and delivers nothing", async () => {
    const requests = initForPerformance({ trackPerformance: false });

    forgeOpsTracker.recordPerformance("never recorded", 10);
    await forgeOpsTracker.flushPerformance();

    expect(requests).toHaveLength(0);
  });

  it("init installs the automatic network timing by default, and trackPerformance: false turns it off", async () => {
    class FakeXhr {
      status = 0;
      private listeners: (() => void)[] = [];
      open(_m: string, _u: string | URL, _a?: boolean, _n?: string | null, _p?: string | null): void {}
      send(_b?: unknown): void {}
      addEventListener(_t: string, l: () => void): void {
        this.listeners.push(l);
      }
      finish(status: number): void {
        this.status = status;
        this.listeners.forEach((l) => l());
      }
    }
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
    try {
      const requests = initForPerformance();
      const xhr = new FakeXhr();
      xhr.open("GET", "https://api.example.com/orders/42");
      xhr.send();
      xhr.finish(200);
      await forgeOpsTracker.flushPerformance();
      expect(JSON.parse(requests[0]!.init!.body as string).samples[0].transaction_name).toBe("GET api.example.com");

      forgeOpsTracker._resetForTesting();
      const offRequests = initForPerformance({ trackPerformance: false });
      const off = new FakeXhr();
      off.open("GET", "https://api.example.com/orders/42");
      off.send();
      off.finish(200);
      await forgeOpsTracker.flushPerformance();
      expect(offRequests).toHaveLength(0);
    } finally {
      delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    }
  });
});
