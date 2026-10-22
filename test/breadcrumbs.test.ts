import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBuffer, installBreadcrumbs, uninstallBreadcrumbs } from "../src/breadcrumbs.js";
import { Configuration } from "../src/configuration.js";

function newConfiguration(): Configuration {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  return config;
}

// A minimal stand-in for React Native's own XMLHttpRequest: not present under plain Node/vitest,
// the same way test/index.test.ts fakes ErrorUtils. Just enough surface for the patched
// open()/send() and the "loadend" listener installNetworkBreadcrumbs registers.
class FakeXMLHttpRequest {
  status = 0;
  private listeners: Record<string, (() => void)[]> = {};

  open(_method: string, _url: string | URL, _async?: boolean, _username?: string | null, _password?: string | null): void {}

  send(_body?: unknown): void {}

  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  finish(status: number): void {
    this.status = status;
    for (const listener of this.listeners.loadend ?? []) listener();
  }
}

const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

beforeEach(() => {
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXMLHttpRequest;
});

afterEach(() => {
  uninstallBreadcrumbs();
  delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  Object.assign(console, originalConsole);
});

describe("BreadcrumbBuffer", () => {
  it("keeps entries in order", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());

    buffer.add({ category: "custom", message: "first", level: "info", timestamp: "t1" });
    buffer.add({ category: "custom", message: "second", level: "info", timestamp: "t2" });

    expect(buffer.all().map((b) => b.message)).toEqual(["first", "second"]);
  });

  it("drops the oldest entries past maxBreadcrumbs", () => {
    const config = newConfiguration();
    config.maxBreadcrumbs = 2;
    const buffer = new BreadcrumbBuffer(config);

    for (const message of ["first", "second", "third"]) {
      buffer.add({ category: "custom", message, level: "info", timestamp: "t" });
    }

    expect(buffer.all().map((b) => b.message)).toEqual(["second", "third"]);
  });

  it("re-reads maxBreadcrumbs on every add, so a change after construction takes effect", () => {
    const config = newConfiguration();
    const buffer = new BreadcrumbBuffer(config);
    buffer.add({ category: "custom", message: "first", level: "info", timestamp: "t" });

    config.maxBreadcrumbs = 0;
    buffer.add({ category: "custom", message: "second", level: "info", timestamp: "t" });

    expect(buffer.all().map((b) => b.message)).toEqual(["first"]);
  });

  it("clear empties the trail", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());
    buffer.add({ category: "custom", message: "first", level: "info", timestamp: "t" });

    buffer.clear();

    expect(buffer.all()).toEqual([]);
  });

  it("all returns a copy, never the live list", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());
    buffer.add({ category: "custom", message: "first", level: "info", timestamp: "t" });

    const snapshot = buffer.all();
    buffer.add({ category: "custom", message: "second", level: "info", timestamp: "t" });

    expect(snapshot).toHaveLength(1);
  });
});

describe("installBreadcrumbs: console", () => {
  it("records each console method with its level, and still calls the original", () => {
    const originalLog = vi.fn();
    console.log = originalLog;
    // Keep this test's own output out of the run: each console method it exercises would print.
    console.warn = vi.fn();
    console.error = vi.fn();
    console.debug = vi.fn();
    const buffer = new BreadcrumbBuffer(newConfiguration());
    installBreadcrumbs(newConfiguration(), buffer);

    console.log("hello", { a: 1 });
    console.warn("careful");
    console.error(new Error("boom"));
    console.debug("noisy");

    expect(originalLog).toHaveBeenCalledWith("hello", { a: 1 });
    expect(buffer.all().map((b) => [b.category, b.level, b.message])).toEqual([
      ["console", "info", 'hello {"a":1}'],
      ["console", "warning", "careful"],
      ["console", "error", "boom"],
      ["console", "debug", "noisy"],
    ]);
  });

  it("truncates a very long message", () => {
    console.info = vi.fn(); // keep the 2000-character line out of the test output
    const buffer = new BreadcrumbBuffer(newConfiguration());
    installBreadcrumbs(newConfiguration(), buffer);

    console.info("x".repeat(2000));

    expect(buffer.all()[0]!.message).toHaveLength(503);
    expect(buffer.all()[0]!.message.endsWith("...")).toBe(true);
  });

  it("is idempotent: a second install does not double-record", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());
    installBreadcrumbs(newConfiguration(), buffer);
    installBreadcrumbs(newConfiguration(), buffer);

    console.info("once");

    expect(buffer.all()).toHaveLength(1);
  });

  it("uninstall restores the identical original console functions", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());
    const before = console.info;
    installBreadcrumbs(newConfiguration(), buffer);
    expect(console.info).not.toBe(before);

    uninstallBreadcrumbs();

    expect(console.info).toBe(before);
  });
});

describe("installBreadcrumbs: network (XMLHttpRequest)", () => {
  function request(method: string, url: string): FakeXMLHttpRequest {
    const xhr = new FakeXMLHttpRequest();
    xhr.open(method, url);
    xhr.send();
    return xhr;
  }

  it("records a completed request with its status and duration", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());
    installBreadcrumbs(newConfiguration(), buffer);

    request("get", "https://api.example.com/orders/42").finish(200);

    const crumb = buffer.all()[0]!;
    expect(crumb.category).toBe("xhr");
    expect(crumb.message).toBe("GET https://api.example.com/orders/42");
    expect(crumb.level).toBe("info");
    expect(crumb.data).toMatchObject({ status: 200 });
    expect(typeof crumb.data!.duration_ms).toBe("number");
  });

  it("marks a 4xx/5xx response as a warning", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());
    installBreadcrumbs(newConfiguration(), buffer);

    request("POST", "https://api.example.com/charge").finish(500);

    expect(buffer.all()[0]!.level).toBe("warning");
  });

  it("never records this client's own delivery requests", () => {
    const buffer = new BreadcrumbBuffer(newConfiguration());
    installBreadcrumbs(newConfiguration(), buffer);

    request("POST", "https://tracker.example.com/api/v1/events").finish(202);

    expect(buffer.all()).toEqual([]);
  });

  it("still calls the original open and send, with the caller's arguments intact", () => {
    const openSpy = vi.spyOn(FakeXMLHttpRequest.prototype, "open");
    const sendSpy = vi.spyOn(FakeXMLHttpRequest.prototype, "send");
    const buffer = new BreadcrumbBuffer(newConfiguration());
    installBreadcrumbs(newConfiguration(), buffer);

    const xhr = new FakeXMLHttpRequest();
    xhr.open("PUT", "https://api.example.com/x", false);
    xhr.send("body");

    // Spied *before* install, so these are the originals the patch wraps.
    expect(openSpy).toHaveBeenCalledWith("PUT", "https://api.example.com/x", false, undefined, undefined);
    expect(sendSpy).toHaveBeenCalledWith("body");
    openSpy.mockRestore();
    sendSpy.mockRestore();
  });

  it("uninstall restores the identical original open and send", () => {
    const originalOpen = FakeXMLHttpRequest.prototype.open;
    const originalSend = FakeXMLHttpRequest.prototype.send;
    installBreadcrumbs(newConfiguration(), new BreadcrumbBuffer(newConfiguration()));

    uninstallBreadcrumbs();

    expect(FakeXMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(FakeXMLHttpRequest.prototype.send).toBe(originalSend);
  });

  it("does nothing, and does not throw, when there is no XMLHttpRequest at all", () => {
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
    const buffer = new BreadcrumbBuffer(newConfiguration());

    expect(() => installBreadcrumbs(newConfiguration(), buffer)).not.toThrow();
    console.info("console still works");
    expect(buffer.all()).toHaveLength(1);
  });
});
