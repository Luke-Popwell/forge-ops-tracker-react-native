import { describe, expect, it } from "vitest";
import { Configuration } from "../src/configuration.js";

describe("Configuration", () => {
  it("defaults", () => {
    const config = new Configuration();
    expect(config.environment).toBe("production");
    expect(config.queueSize).toBe(1000);
    expect(config.scrubPii).toBe(true);
    expect(config.inAppHeuristicEnabled).toBe(false);
    expect(config.enabledEnvironments.has("production")).toBe(true);
    expect(config.enabledEnvironments.has("staging")).toBe(true);
    expect(config.propagateTraces).toBe(true);
    expect(config.tracePropagationTargets).toBeUndefined();
  });

  it("propagatesTraceTo: every host by default, nothing when propagateTraces is off", () => {
    const config = new Configuration();
    expect(config.propagatesTraceTo("api.example.com")).toBe(true);

    config.propagateTraces = false;
    config.tracePropagationTargets = ["example.com"];
    expect(config.propagatesTraceTo("api.example.com")).toBe(false);
  });

  it("propagatesTraceTo: a string matches the host or a subdomain on a dot boundary, a RegExp is tested against the host", () => {
    const config = new Configuration();
    config.tracePropagationTargets = ["Example.com", /^10\.0\./g];

    expect(config.propagatesTraceTo("example.com")).toBe(true);
    expect(config.propagatesTraceTo("API.example.com")).toBe(true);
    expect(config.propagatesTraceTo("badexample.com")).toBe(false);
    expect(config.propagatesTraceTo("example.com.evil.net")).toBe(false);
    // Twice: a /g pattern's lastIndex must not make the second test fail.
    expect(config.propagatesTraceTo("10.0.2.2")).toBe(true);
    expect(config.propagatesTraceTo("10.0.2.2")).toBe(true);
    expect(config.propagatesTraceTo("192.168.0.1")).toBe(false);

    config.tracePropagationTargets = [];
    expect(config.propagatesTraceTo("example.com")).toBe(false);
  });

  it("apiKey and ingestionUri", () => {
    const config = new Configuration();
    config.dsn = "https://abc123@forgeops.example/api/v1/events";

    expect(config.apiKey()).toBe("abc123");
    expect(config.ingestionUri()).toBe("https://forgeops.example/api/v1/events");
  });

  it("apiKey url-decodes the userinfo", () => {
    const config = new Configuration();
    config.dsn = "https://ab%2Fc@forgeops.example/api/v1/events";

    expect(config.apiKey()).toBe("ab/c");
  });

  it("empty or malformed dsn has no apiKey or ingestionUri", () => {
    for (const dsn of ["", "not-a-url"]) {
      const config = new Configuration();
      config.dsn = dsn;
      expect(config.apiKey()).toBeNull();
      expect(config.ingestionUri()).toBeNull();
    }
  });

  it("dsn with no userinfo has no apiKey but still has an ingestionUri", () => {
    const config = new Configuration();
    config.dsn = "https://forgeops.example/no-userinfo";

    expect(config.apiKey()).toBeNull();
    expect(config.ingestionUri()).toBe("https://forgeops.example/no-userinfo");
  });

  it("isEnabled requires dsn, apiKey, and an enabled environment", () => {
    const config = new Configuration();
    config.dsn = "https://key@host/path";

    config.environment = "production";
    expect(config.isEnabled()).toBe(true);

    config.environment = "development";
    expect(config.isEnabled()).toBe(false);

    config.environment = "production";
    config.dsn = null;
    expect(config.isEnabled()).toBe(false);
  });

  it("log calls the configured logger", () => {
    const config = new Configuration();
    let received: string | undefined;
    config.logger = (message) => (received = message);

    config.log("something happened");

    expect(received).toBe("something happened");
  });

  it("log does nothing when no logger is configured", () => {
    const config = new Configuration();
    expect(() => config.log("should not throw")).not.toThrow();
  });

  it("performanceSamplesUri swaps the trailing events segment", () => {
    const config = new Configuration();
    config.dsn = "https://key@tracker.example.com/api/v1/events";

    expect(config.performanceSamplesUri()).toBe("https://tracker.example.com/api/v1/performance_samples");

    config.dsn = null;
    expect(config.performanceSamplesUri()).toBeNull();
  });
});
