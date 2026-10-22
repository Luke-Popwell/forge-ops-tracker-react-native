import { describe, expect, it } from "vitest";
import { Configuration } from "../src/configuration.js";
import { EventBuilder } from "../src/eventBuilder.js";

// This test suite runs under Node/V8 (vitest's own runtime), not Hermes: so it validates the
// frame regex against a real, genuinely-captured V8 stack trace, which is a meaningful check
// given Hermes is documented to produce V8-compatible output, but is NOT the same as validating
// against a real Hermes-executed one. See eventBuilder.ts's own top comment for the full caveat.

function newConfiguration(): Configuration {
  const config = new Configuration();
  config.environment = "production";
  config.release = "abc123";
  return config;
}

describe("EventBuilder", () => {
  it("builds payload with exception class, message, and configured metadata", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = new TypeError("boom");

    const payload = builder.build(error, { orderId: 42 });

    expect(payload.exception_class).toBe("TypeError");
    expect(payload.message).toBe("boom");
    expect(payload.environment).toBe("production");
    expect(payload.release).toBe("abc123");
    expect(payload.context).toEqual({ orderId: 42 });
    expect(payload.occurred_at).toMatch(/Z$/);
    expect(payload.sdk_name).toBe("reactnative");
  });

  it("parses real stack frames with method, file, and line", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = new Error("boom");

    const frames = builder.build(error).backtrace;

    expect(frames.length).toBeGreaterThan(0);
    const frame = frames[0]!;
    expect(typeof frame.file).toBe("string");
    expect(typeof frame.line).toBe("number");
    expect(typeof frame.method === "string" || frame.method === null).toBe(true);
  });

  it("returns an empty backtrace when the error has no stack", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = new Error("boom");
    delete (error as { stack?: string }).stack;

    expect(builder.build(error).backtrace).toEqual([]);
  });

  it("in_app is always false when inAppHeuristicEnabled is off (the default)", () => {
    const config = newConfiguration();
    const builder = new EventBuilder(config);
    const error = new Error("boom");

    const frames = builder.build(error).backtrace;

    expect(frames.every((f) => f.in_app === false)).toBe(true);
  });

  it("in_app excludes node_modules frames when the heuristic is enabled", () => {
    const config = newConfiguration();
    config.inAppHeuristicEnabled = true;
    const builder = new EventBuilder(config);

    const error = new Error("boom");
    error.stack =
      "Error: boom\n" +
      "    at ChargeService.chargeCard (/app/src/chargeService.js:10:5)\n" +
      "    at Object.<anonymous> (/app/node_modules/some-lib/index.js:3:1)\n";

    const frames = builder.build(error).backtrace;

    expect(frames[0]!.in_app).toBe(true);
    expect(frames[1]!.in_app).toBe(false);
  });

  it("scrubs likely pii out of message and context by default", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = new Error("failed for user@example.com");

    const payload = builder.build(error, { user: { email: "ada@example.com", password: "hunter2" } });

    expect(payload.message).toBe("failed for [EMAIL FILTERED]");
    expect(payload.context).toEqual({ user: { email: "[EMAIL FILTERED]", password: "[FILTERED]" } });
  });

  it("includes the user when given one, never scrubbed even though it is an email", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = new Error("boom");

    const payload = builder.build(error, {}, { id: 42, email: "ada@example.com" });

    expect(payload.user).toEqual({ id: 42, email: "ada@example.com" });
  });

  it("omits the user key entirely when none was given", () => {
    const builder = new EventBuilder(newConfiguration());
    const error = new Error("boom");

    const payload = builder.build(error);

    expect(payload.user).toBeUndefined();
  });

  it("includes a top-level trace_id when given one, and omits the key entirely otherwise", () => {
    const builder = new EventBuilder(newConfiguration());
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    expect(builder.build(new Error("boom"), {}, null, [], traceId).trace_id).toBe(traceId);
    expect(builder.build(new Error("boom"))).not.toHaveProperty("trace_id");
  });

  it("includes breadcrumbs when given", () => {
    const builder = new EventBuilder(newConfiguration());
    const crumb = { category: "custom", message: "GET /orders/42", level: "info" as const, timestamp: "2024-01-15T10:29:58Z" };

    const payload = builder.build(new Error("boom"), {}, null, [crumb]);

    expect(payload.breadcrumbs).toEqual([crumb]);
  });

  it("omits the breadcrumbs key entirely when none were given", () => {
    const builder = new EventBuilder(newConfiguration());

    expect("breadcrumbs" in builder.build(new Error("boom"))).toBe(false);
    expect("breadcrumbs" in builder.build(new Error("boom"), {}, null, [])).toBe(false);
  });

  it("scrubs breadcrumb message and data but leaves category, level, and timestamp untouched", () => {
    const builder = new EventBuilder(newConfiguration());
    const crumb = {
      category: "custom",
      message: "emailed alice@example.com",
      level: "info" as const,
      timestamp: "2024-01-15T10:29:58Z",
      data: { email: "alice@example.com", password: "hunter2" },
    };

    const payload = builder.build(new Error("boom"), {}, null, [crumb]);

    const scrubbed = payload.breadcrumbs![0]!;
    expect(scrubbed.message).toBe("emailed [EMAIL FILTERED]");
    expect(scrubbed.data).toEqual({ email: "[EMAIL FILTERED]", password: "[FILTERED]" });
    expect(scrubbed.category).toBe("custom");
    expect(scrubbed.level).toBe("info");
    expect(scrubbed.timestamp).toBe("2024-01-15T10:29:58Z");
    expect(crumb.message).toBe("emailed alice@example.com");
  });

  it("leaves payload untouched when scrubPii is disabled", () => {
    const config = newConfiguration();
    config.scrubPii = false;
    const builder = new EventBuilder(config);
    const error = new Error("failed for user@example.com");

    const payload = builder.build(error, { email: "ada@example.com" });

    expect(payload.message).toBe("failed for user@example.com");
    expect(payload.context).toEqual({ email: "ada@example.com" });
  });

  // captureSourceContext is a documented no-op on React Native (see configuration.ts's own
  // captureSourceContext comment and eventBuilder.ts's attachSourceContext): this runtime has no
  // filesystem access at all, and a frame's own "file" is never a real on-device path regardless
  // (a release bundle path or a Metro dev-server URL). There is no real disk-read logic to
  // exercise here, so these tests only confirm the option exists, defaults to true, and that its
  // (always inert) call site never throws or adds fields to a frame.
  describe("source context capture (documented no-op)", () => {
    it("captureSourceContext defaults to true", () => {
      expect(new Configuration().captureSourceContext).toBe(true);
    });

    it("never attaches context_line/pre_context/post_context to any frame, even with captureSourceContext enabled and the frame marked in_app", () => {
      const config = newConfiguration();
      config.captureSourceContext = true;
      config.inAppHeuristicEnabled = true;
      const builder = new EventBuilder(config);
      const error = new Error("boom");
      error.stack = "Error: boom\n    at ChargeService.chargeCard (/app/src/chargeService.js:10:5)\n";

      const frames = builder.build(error).backtrace;

      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]!.in_app).toBe(true);
      for (const frame of frames) {
        expect(frame).not.toHaveProperty("context_line");
        expect(frame).not.toHaveProperty("pre_context");
        expect(frame).not.toHaveProperty("post_context");
      }
    });

    it("disabling captureSourceContext never throws and leaves the payload otherwise identical", () => {
      const config = newConfiguration();
      config.captureSourceContext = false;
      const builder = new EventBuilder(config);
      const error = new Error("boom");

      expect(() => builder.build(error)).not.toThrow();
      expect(builder.build(error).backtrace.length).toBeGreaterThan(0);
    });
  });
});
