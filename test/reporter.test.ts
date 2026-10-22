import { describe, expect, it } from "vitest";
import { BreadcrumbBuffer } from "../src/breadcrumbs.js";
import { Configuration } from "../src/configuration.js";
import { Reporter } from "../src/reporter.js";

function enabledConfiguration(): Configuration {
  const config = new Configuration();
  config.dsn = "https://key@tracker.example.com/api/v1/events";
  config.enabledEnvironments = new Set(["production"]);
  config.environment = "production";
  return config;
}

describe("Reporter", () => {
  it("passes the breadcrumb trail through to the event builder", () => {
    const configuration = enabledConfiguration();
    const buffer = new BreadcrumbBuffer(configuration);
    buffer.add({ category: "custom", message: "hi", level: "info", timestamp: "t" });
    const buildCalls: unknown[][] = [];
    const eventBuilder = {
      build: (...args: unknown[]) => (buildCalls.push(args), {}),
    };
    const deliveryQueue = { push: () => true };

    new Reporter(configuration, eventBuilder as never, deliveryQueue as never, buffer).report(new Error("boom"));

    expect(buildCalls[0]![3]).toEqual(buffer.all());
  });

  it("builds and enqueues a payload when reporting is enabled", () => {
    const configuration = enabledConfiguration();
    const builtPayload = { exception_class: "RuntimeError" };
    const buildCalls: unknown[][] = [];
    const pushCalls: unknown[] = [];
    const eventBuilder = {
      build: (error: Error, context: unknown) => (buildCalls.push([error, context]), builtPayload),
    };
    const deliveryQueue = { push: (payload: unknown) => pushCalls.push(payload) };

    const reporter = new Reporter(configuration, eventBuilder as never, deliveryQueue as never);
    const error = new Error("boom");
    const context = { a: 1 };

    reporter.report(error, context);

    expect(buildCalls).toEqual([[error, context]]);
    expect(pushCalls).toEqual([builtPayload]);
  });

  it("passes the user through to the event builder", () => {
    const configuration = enabledConfiguration();
    const builtPayload = { exception_class: "RuntimeError" };
    const buildCalls: unknown[][] = [];
    const eventBuilder = {
      build: (error: Error, context: unknown, user: unknown) => (buildCalls.push([error, context, user]), builtPayload),
    };
    const deliveryQueue = { push: () => {} };
    const error = new Error("boom");
    const user = { id: 42, email: "alice@example.com" };

    new Reporter(configuration, eventBuilder as never, deliveryQueue as never).report(error, {}, user);

    expect(buildCalls).toEqual([[error, {}, user]]);
  });

  it("does nothing when reporting is disabled", () => {
    const configuration = enabledConfiguration();
    configuration.environment = "development"; // not in enabledEnvironments
    let pushCallCount = 0;
    const eventBuilder = { build: () => ({}) };
    const deliveryQueue = { push: () => (pushCallCount += 1) };

    new Reporter(configuration, eventBuilder as never, deliveryQueue as never).report(new Error("boom"));

    expect(pushCallCount).toBe(0);
  });

  it("never throws even if building the event fails", () => {
    const configuration = enabledConfiguration();
    const eventBuilder = {
      build: () => {
        throw new Error("event builder exploded");
      },
    };
    const deliveryQueue = { push: () => {} };

    expect(() => {
      new Reporter(configuration, eventBuilder as never, deliveryQueue as never).report(new Error("boom"));
    }).not.toThrow();
  });

  it("never throws even if enqueueing fails", () => {
    const configuration = enabledConfiguration();
    const eventBuilder = { build: () => ({}) };
    const deliveryQueue = {
      push: () => {
        throw new Error("queue exploded");
      },
    };

    expect(() => {
      new Reporter(configuration, eventBuilder as never, deliveryQueue as never).report(new Error("boom"));
    }).not.toThrow();
  });
});
