import { Configuration } from "./configuration.js";
import { EventPayload, StrictEventPayload } from "./eventBuilder.js";
import type { PerformanceSample } from "./performanceFlusher.js";
import type { TracePayload } from "./tracing.js";
import type { ChangePayload } from "./changes.js";

/**
 * What became of one delivery. The three are told apart because the caller owes each a different
 * answer: "delivered" (any 2xx) is done; "rejected" (a 4xx other than 408 and 429) is a payload the
 * server will never take, so sending it again only repeats the refusal; "failed" (a network error,
 * a timeout, a 5xx, a 408 or a 429) may well go through later.
 */
export type DeliveryStatus = "delivered" | "rejected" | "failed";

/**
 * How many flushes in a row may fail before a flusher or buffer gives up on the batch it is holding
 * and starts clean, so an endpoint that stays down can't keep one batch growing for good.
 */
export const MAX_FAILED_FLUSHES = 5;

function statusFor(status: number): DeliveryStatus {
  if (status >= 200 && status < 300) {
    return "delivered";
  }
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return "rejected";
  }
  return "failed";
}

/**
 * Delivers one payload over HTTP. Every failure mode: a network error, a timeout, a non-2xx
 * response: is caught here and turned into a "rejected" or "failed" return rather than a thrown
 * exception, since a broken or unreachable tracker must never be able to break the host app. Uses React
 * Native's global fetch() (RN's own polyfill, present without any setup in every RN app), not a
 * package dependency: same reasoning as every other SDK in this repo (see sdks/node/src/client.js
 * and sdks/typescript/src/client.ts): this has to work in any host app without adding an HTTP
 * client dependency of its own.
 */
export class Client {
  private configuration: Configuration;

  constructor(configuration: Configuration) {
    this.configuration = configuration;
  }

  async deliver(payload: EventPayload | StrictEventPayload): Promise<DeliveryStatus> {
    return this.post(this.configuration.ingestionUri(), payload);
  }

  /**
   * Same delivery contract as deliver(), against the DSN's performance_samples endpoint (see
   * Configuration#performanceSamplesUri). `samples` is wrapped as {"samples": [...]}, the shape
   * Api::V1::PerformanceSamplesController expects.
   */
  async deliverPerformanceSamples(samples: PerformanceSample[]): Promise<DeliveryStatus> {
    return this.post(this.configuration.performanceSamplesUri(), { samples });
  }

  /**
   * Same delivery contract again, against the DSN's custom metrics and infrastructure metrics endpoints.
   * `entries` is wrapped as {"metrics": [...]}.
   */
  async deliverMetrics(entries: Record<string, unknown>[]): Promise<DeliveryStatus> {
    return this.post(this.configuration.customMetricsUri(), { metrics: entries });
  }

  async deliverInfrastructureMetrics(entries: Record<string, unknown>[]): Promise<DeliveryStatus> {
    return this.post(this.configuration.infrastructureMetricsUri(), { metrics: entries });
  }

  /**
   * Same delivery contract again, against the DSN's spans endpoint (see Configuration#spansUri).
   * `trace` is sent as-is: {"trace_id": ..., "spans": [...]}, the shape Api::V1::SpansController
   * expects.
   */
  async deliverSpans(trace: TracePayload): Promise<DeliveryStatus> {
    return this.post(this.configuration.spansUri(), trace);
  }

  /**
   * Same delivery contract again, against the DSN's changes endpoint (see Configuration#changesUri).
   * A 403 (a plan without change tracking) is just a "rejected" like any other 4xx, never logged here.
   */
  async deliverChange(change: ChangePayload): Promise<DeliveryStatus> {
    return this.post(this.configuration.changesUri(), change);
  }

  private async post(uri: string | null, payload: unknown): Promise<DeliveryStatus> {
    const apiKey = this.configuration.apiKey();
    if (!uri || !apiKey) {
      return "failed";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.configuration.timeoutMs);

    try {
      const response = await fetch(uri, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      return statusFor(response.status);
    } catch (e) {
      const err = e as Error;
      this.configuration.log(`[forge-ops-tracker] delivery failed: ${err.name}: ${err.message}`);
      return "failed";
    } finally {
      clearTimeout(timeout);
    }
  }
}
