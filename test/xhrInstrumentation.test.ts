import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Configuration } from "../src/configuration.js";
import { addXhrListener, isOwnRequest } from "../src/xhrInstrumentation.js";

class FakeXMLHttpRequest {
  status = 0;
  private listeners: (() => void)[] = [];
  open(_method: string, _url: string | URL, _async?: boolean, _username?: string | null, _password?: string | null): void {}
  send(_body?: unknown): void {}
  addEventListener(_type: string, listener: () => void): void {
    this.listeners.push(listener);
  }
  finish(status: number): void {
    this.status = status;
    this.listeners.forEach((l) => l());
  }
}

function config(): Configuration {
  const c = new Configuration();
  c.dsn = "https://key@tracker.example.com/api/v1/events";
  return c;
}

function request(url: string): FakeXMLHttpRequest {
  const xhr = new FakeXMLHttpRequest();
  xhr.open("GET", url);
  xhr.send();
  return xhr;
}

beforeEach(() => {
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXMLHttpRequest;
});

afterEach(() => {
  delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
});

describe("xhrInstrumentation", () => {
  it("patches once for any number of listeners, and every listener sees every request", () => {
    const seenA: string[] = [];
    const seenB: string[] = [];
    const removeA = addXhrListener(config(), (c) => seenA.push(c.url));
    const patched = FakeXMLHttpRequest.prototype.open;
    const removeB = addXhrListener(config(), (c) => seenB.push(c.url));

    expect(FakeXMLHttpRequest.prototype.open).toBe(patched); // the second listener did not wrap it again
    request("https://api.example.com/x").finish(200);

    expect(seenA).toEqual(["https://api.example.com/x"]);
    expect(seenB).toEqual(["https://api.example.com/x"]);
    removeA();
    removeB();
  });

  it("removing one listener leaves the other working; removing the last restores the originals", () => {
    const originalOpen = FakeXMLHttpRequest.prototype.open;
    const originalSend = FakeXMLHttpRequest.prototype.send;
    const seenB: string[] = [];
    const removeA = addXhrListener(config(), () => {});
    const removeB = addXhrListener(config(), (c) => seenB.push(c.url));

    removeA();
    request("https://api.example.com/x").finish(200);
    expect(seenB).toHaveLength(1);
    expect(FakeXMLHttpRequest.prototype.open).not.toBe(originalOpen);

    removeB();
    expect(FakeXMLHttpRequest.prototype.open).toBe(originalOpen);
    expect(FakeXMLHttpRequest.prototype.send).toBe(originalSend);
  });

  it("does nothing, and does not throw, when there is no XMLHttpRequest at all", () => {
    delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;

    const remove = addXhrListener(config(), () => {});

    expect(remove).not.toThrow();
  });

  it("beforeSend can read and add headers, and its return value comes back with that request's completion", () => {
    class WithHeaders extends FakeXMLHttpRequest {
      sent: Record<string, string> = {};
      setRequestHeader(name: string, value: string): void {
        this.sent[name] = value;
      }
    }
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = WithHeaders;
    const originalSetRequestHeader = WithHeaders.prototype.setRequestHeader;
    const seenAppHeader: (string | undefined)[] = [];
    const states: unknown[] = [];
    const remove = addXhrListener(
      config(),
      (_completion, state) => states.push(state),
      (request) => {
        seenAppHeader.push(request.header("X-App"));
        request.setHeader("traceparent", "tp");
        return `state for ${request.url}`;
      },
    );

    const xhr = new WithHeaders();
    xhr.open("GET", "https://api.example.com/x");
    xhr.setRequestHeader("x-app", "1");
    xhr.send();
    xhr.finish(200);
    const own = new WithHeaders();
    own.open("POST", "https://tracker.example.com/api/v1/events");
    own.send();
    own.finish(202);

    expect(seenAppHeader).toEqual(["1"]);
    expect(xhr.sent).toEqual({ "x-app": "1", traceparent: "tp" });
    expect(own.sent).toEqual({});
    expect(states).toEqual(["state for https://api.example.com/x"]);
    remove();
    expect(WithHeaders.prototype.setRequestHeader).toBe(originalSetRequestHeader);
  });

  it("a beforeSend that throws never stops the request from going out", () => {
    const sends: string[] = [];
    const originalSend = FakeXMLHttpRequest.prototype.send;
    FakeXMLHttpRequest.prototype.send = function () {
      sends.push("sent");
    };
    const seen: string[] = [];
    const remove = addXhrListener(
      config(),
      (c) => seen.push(c.url),
      () => {
        throw new Error("boom");
      },
    );

    request("https://api.example.com/x").finish(200);

    expect(sends).toEqual(["sent"]);
    expect(seen).toEqual(["https://api.example.com/x"]);
    remove();
    FakeXMLHttpRequest.prototype.send = originalSend;
  });

  it("isOwnRequest matches every endpoint under the DSN's directory, and nothing else", () => {
    const c = config();

    expect(isOwnRequest(c, "https://tracker.example.com/api/v1/events")).toBe(true);
    expect(isOwnRequest(c, "https://tracker.example.com/api/v1/performance_samples")).toBe(true);
    expect(isOwnRequest(c, "https://tracker.example.com/other")).toBe(false);
    expect(isOwnRequest(c, "https://api.example.com/api/v1/events")).toBe(false);
    expect(isOwnRequest(new Configuration(), "https://tracker.example.com/api/v1/events")).toBe(false);
  });
});
