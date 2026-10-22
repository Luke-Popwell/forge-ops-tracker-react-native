// react-native-globals.d.ts (declaring ErrorUtils/__DEV__) needs no import: tsconfig's own
// "include": ["src"] already picks up every .d.ts under this tree as an ambient global
// declaration automatically.
import { RecordChangeOptions, buildChangePayload } from "./changes.js";
import { Breadcrumb, BreadcrumbBuffer, installBreadcrumbs, uninstallBreadcrumbs } from "./breadcrumbs.js";
import { Client } from "./client.js";
import { Configuration } from "./configuration.js";
import { PerformanceFlusher, installHttpPerformance } from "./performanceFlusher.js";
import { DeliveryQueue } from "./deliveryQueue.js";
import { EventBuilder } from "./eventBuilder.js";
import { Reporter } from "./reporter.js";
import { MetricBuffer } from "./metricBuffer.js";
import { SpanQueue, Trace, installHttpTracing, soleOpenTrace } from "./tracing.js";

export { Configuration };
export type { BacktraceFrame, EventPayload, StrictEventPayload } from "./eventBuilder.js";
export type { Breadcrumb, BreadcrumbLevel } from "./breadcrumbs.js";
export { Trace } from "./tracing.js";
export { withSql } from "./sqlStatement.js";
export { CHANGE_KINDS } from "./changes.js";
export type { ChangeKind, RecordChangeOptions } from "./changes.js";
export type { HttpSpan, RecordSpanOptions, SpanKind, SpanOptions, TraceScope } from "./tracing.js";

let configuration: Configuration | null = null;
let reporter: Reporter | null = null;
let breadcrumbBuffer: BreadcrumbBuffer | null = null;
let performanceFlusher: PerformanceFlusher | null = null;
let stopHttpPerformance: (() => void) | null = null;
let spanQueue: SpanQueue | null = null;
let metricBuffers: { custom: MetricBuffer; infrastructure: MetricBuffer } | null = null;
let stopHttpTracing: (() => void) | null = null;
const openTraces = new Set<Trace>();
let handlersInstalled = false;
let previousErrorHandler: ((error: unknown, isFatal?: boolean) => void) | null = null;

// The user set via setUser, if any. A mobile app install is effectively single-user (unlike a
// server handling many concurrent requests at once, the reason sdks/node needs AsyncLocalStorage
// instead), so this is a plain module-level variable, not any kind of per-request storage: the
// same reasoning sdks/swift/sdks/android's own plain static property documents.
let currentUser: Record<string, unknown> | null = null;

function getConfiguration(): Configuration {
  if (configuration === null) {
    configuration = new Configuration();
  }
  return configuration;
}

function getBreadcrumbBuffer(): BreadcrumbBuffer {
  if (breadcrumbBuffer === null) {
    breadcrumbBuffer = new BreadcrumbBuffer(getConfiguration());
  }
  return breadcrumbBuffer;
}

function getPerformanceFlusher(): PerformanceFlusher {
  if (performanceFlusher === null) {
    const config = getConfiguration();
    performanceFlusher = new PerformanceFlusher(config, new Client(config));
  }
  return performanceFlusher;
}

/** The two metric buffers, created together on first use: independent of each other (an app may only ever call one), but cheap enough that creating both is simpler than tracking which. */
function getMetricBuffers(): { custom: MetricBuffer; infrastructure: MetricBuffer } {
  if (metricBuffers === null) {
    const config = getConfiguration();
    const client = new Client(config);
    metricBuffers = {
      custom: new MetricBuffer(config, (entries) => client.deliverMetrics(entries), () => config.metricFlushIntervalMs),
      infrastructure: new MetricBuffer(
        config,
        (entries) => client.deliverInfrastructureMetrics(entries),
        () => config.infrastructureMetricFlushIntervalMs,
      ),
    };
  }
  return metricBuffers;
}

function getSpanQueue(): SpanQueue {
  if (spanQueue === null) {
    const config = getConfiguration();
    spanQueue = new SpanQueue(config, new Client(config));
  }
  return spanQueue;
}

function getReporter(): Reporter {
  if (reporter === null) {
    const config = getConfiguration();
    const client = new Client(config);
    const deliveryQueue = new DeliveryQueue(config, client);
    reporter = new Reporter(config, new EventBuilder(config), deliveryQueue, getBreadcrumbBuffer());
  }
  return reporter;
}

export interface InitOptions extends Partial<Configuration> {
  /** Install the ErrorUtils global handler and unhandled-promise-rejection tracking. Defaults to
   * true. */
  installGlobalHandlers?: boolean;
}

/** Configure the client. Call once, as early as possible: the top of your app's entry file,
 * before any other code runs. */
export function init(options: InitOptions = {}): Configuration {
  const config = getConfiguration();
  const { installGlobalHandlers, ...overrides } = options;

  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in config)) {
      throw new TypeError(`Configuration has no property ${JSON.stringify(key)}`);
    }
    (config as unknown as Record<string, unknown>)[key] = value;
  }

  if (installGlobalHandlers ?? true) {
    installGlobalErrorHandler();
    installUnhandledRejectionTracking();
  }

  // Strict privacy records no breadcrumbs at all (see strictPrivacy.ts).
  if (config.breadcrumbs && !config.strictPrivacy) {
    installBreadcrumbs(config, getBreadcrumbBuffer());
  } else if (config.strictPrivacy) {
    uninstallBreadcrumbs();
  }

  if (config.trackPerformance && stopHttpPerformance === null) {
    stopHttpPerformance = installHttpPerformance(config, getPerformanceFlusher());
  }

  if (config.trackTracing && stopHttpTracing === null) {
    stopHttpTracing = installHttpTracing(config, openTraces);
  }

  return config;
}

/**
 * Distributed tracing: one flow's own call tree (a screen load, a sign-in, a network round trip and
 * what it triggered), sent to ForgeOps only when the whole thing took at least
 * `traceCaptureThresholdMs` (1s), so fast flows cost nothing on the wire. A request made inside the
 * trace carries a W3C `traceparent` header, so a backend reporting to ForgeOps continues the same
 * trace, and an error captured while it's open carries its trace id.
 *
 *     const feed = await trace("HomeScreen.load", async (t) => {
 *       const items = await t.span("fetch feed", () => api.fetchFeed(), { kind: "http" });
 *       return t.span("decode", () => decode(items), { data: { count: items.length } });
 *     });
 *
 * Or hold the trace yourself across the flow and finish it when it ends:
 *
 *     const t = startTrace("Checkout");
 *     ...
 *     t.finish();
 *
 * Every network request made while exactly one trace is open is also recorded into it, as an "http"
 * span named "METHOD host", and gets the `traceparent` header (see Configuration#propagateTraces and
 * #tracePropagationTargets); `t.fetch()` and `t.httpSpan()` do the same explicitly, under any
 * span. Nesting is explicit: a span's callback receives the scope to nest
 * children under (React Native has no async-context storage), which stays correct across `await`s
 * and for children started in parallel. `trace()` finishes even if `fn` throws or rejects (the
 * error propagates unchanged). When tracing is off, or reporting isn't enabled, everything is a
 * no-op that still runs `fn`, so callers never check. Delivery is in-memory and async: call
 * `flushSpans()` from an AppState "background" listener.
 */
export function trace<T>(name: string, fn: (trace: Trace) => T): T {
  const t = startTrace(name);
  let result: T;
  try {
    result = fn(t);
  } catch (error) {
    t.finish();
    throw error;
  }

  if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        t.finish();
        return value;
      },
      (error: unknown) => {
        t.finish();
        throw error;
      },
    ) as T;
  }

  t.finish();
  return result;
}

/** Starts a trace you finish yourself with `finish()`: see `trace()`. Returns a disabled no-op trace when tracing is off or reporting isn't enabled. */
export function startTrace(name: string): Trace {
  const config = getConfiguration();
  if (!config.trackTracing || !config.isEnabled()) {
    return new Trace(name, config, null);
  }

  const queue = getSpanQueue();
  const t = new Trace(
    name,
    config,
    (payload) => queue.push(payload),
    (finished) => openTraces.delete(finished),
  );
  openTraces.add(t);
  return t;
}

/**
 * Records a named business metric (a purchase, a sign-up, anything you want to name), buffered and
 * flushed periodically as one batch rather than one network call per capture. `value` defaults to 1 so
 * a bare counter-style call needs no argument; pass one for a real magnitude
 * (`captureMetric("payment", 49)`); it may be negative (a refund). A no-op when reporting isn't enabled
 * (no DSN, or this environment isn't in `enabledEnvironments`), and a NaN or infinite value is dropped.
 * Nothing here is automatic, so there is no `trackMetrics` flag.
 *
 * A mobile app is suspended shortly after it goes to the background and nothing is flushed then, so
 * call `flushMetrics()` from an AppState "background" listener (see README.md).
 */
export function captureMetric(name: string, value = 1): void {
  const config = getConfiguration();
  if (!config.isEnabled()) {
    return;
  }
  getMetricBuffers().custom.record({ metric_name: name, value, environment: config.environment, release: config.release ?? null });
}

/**
 * Records one infrastructure reading (battery, memory, anything else your app measures) from a device or
 * one of your own hosts. `hostname` defaults to `Configuration#serverName`. Same buffered-batch delivery
 * and no-op-when-disabled contract as `captureMetric`.
 */
export function captureInfrastructureMetric(name: string, value: number, options: { hostname?: string } = {}): void {
  const config = getConfiguration();
  if (!config.isEnabled()) {
    return;
  }
  const hostname = options.hostname ?? config.serverName;
  if (!hostname) {
    // The endpoint requires one and skips a row without it: say so here instead of sending it.
    config.log("[forge-ops-tracker] dropped an infrastructure metric with no hostname: pass one or set serverName");
    return;
  }
  getMetricBuffers().infrastructure.record({ metric_name: name, value, hostname });
}

/**
 * Records one change to what your app is running: a feature flag flipped, a remote config value
 * updated, anything that could explain a shift in errors or performance. ForgeOps shows it on the
 * timeline next to the errors around it. `kind` is one of CHANGE_KINDS; anything else is sent as
 * "other". Sent right away, in the background: this returns immediately and never throws, even when
 * the request fails or the plan doesn't include change tracking. A no-op when reporting isn't enabled.
 *
 *     remoteConfig.onConfigUpdated(() => {
 *       recordChange("config", "remote config updated", { details: { keys: updatedKeys } });
 *     });
 */
export function recordChange(kind: string, title: string, options: RecordChangeOptions = {}): void {
  try {
    const config = getConfiguration();
    if (!config.isEnabled()) {
      return;
    }
    const payload = buildChangePayload(config, kind, title, options);
    if (payload === null) {
      config.log("[forge-ops-tracker] dropped a change with no title");
      return;
    }
    // Deliberately not awaited: post() never rejects, and a flag callback shouldn't wait on the network.
    void new Client(config).deliverChange(payload);
  } catch (e) {
    const err = e as Error;
    getConfiguration().log(`[forge-ops-tracker] recordChange failed: ${err.name}: ${err.message}`);
  }
}

/** Delivers every buffered metric and infrastructure reading right now, instead of waiting for the next flush interval. */
export async function flushMetrics(): Promise<void> {
  if (metricBuffers === null) {
    return;
  }
  await Promise.all([metricBuffers.custom.flush(), metricBuffers.infrastructure.flush()]);
}

/**
 * Delivers every finished trace that is still queued. A mobile app is suspended shortly after it
 * goes to the background and nothing is flushed then, so call this from an AppState "background"
 * listener (see README.md).
 */
export function flushSpans(): Promise<void> {
  return spanQueue?.flush() ?? Promise.resolve();
}

/**
 * Report an exception you've already caught. `user` defaults to whatever `setUser` last set, if
 * anything; pass one explicitly to override that for this one report. Captured while exactly one
 * trace is open (see `trace()`), the event carries that trace's id, which is what links it to an
 * error the backend reported for the same request.
 */
export function captureException(
  error: Error,
  context: Record<string, unknown> = {},
  user?: Record<string, unknown> | null,
): void {
  getReporter().report(error, context, user ?? currentUser, soleOpenTrace(openTraces)?.traceId ?? null);
}

/**
 * Adds a custom breadcrumb to the trail alongside whatever the automatic sources are already
 * capturing (see breadcrumbs.ts), for anything specific to this app that none of them would know
 * to record, e.g. a screen change from your own navigation library's callback:
 *
 *     addBreadcrumb({ category: "navigation", message: "Home -> Checkout" });
 *
 * `category` defaults to "custom" and `level` to "info" (unlike sdks/typescript, where both are
 * required). Works even with `Configuration#breadcrumbs` turned off: that flag only gates the
 * automatic sources. `message` and `data` are PII-scrubbed like the rest of the payload. With
 * `Configuration#strictPrivacy` on it records nothing.
 */
export function addBreadcrumb(breadcrumb: Partial<Breadcrumb> & Pick<Breadcrumb, "message">): void {
  getBreadcrumbBuffer().add({
    category: "custom",
    level: "info",
    timestamp: new Date().toISOString(),
    ...breadcrumb,
  });
}

/** Empties the breadcrumb trail. A mobile app is effectively single-flow (one shared trail, like
 * `setUser`'s one shared user), so this is only needed to start a new logical unit of work (say,
 * a new sign-in session) with a fresh trail. */
export function clearBreadcrumbs(): void {
  getBreadcrumbBuffer().clear();
}

/**
 * Records one timed call's duration, in milliseconds, under `transactionName`: tallied in-process
 * (count, total, max) and flushed every `performanceFlushIntervalMs` (60s) as one small aggregate
 * report per transaction, for the Performance page's per-transaction table, not one network call
 * per call. A no-op when `Configuration#trackPerformance` is false or reporting isn't enabled for
 * this environment.
 *
 * Every network request is already timed automatically, under "METHOD host" (see
 * performanceFlusher.ts's installHttpPerformance); this is for anything else you want on the
 * Performance page, e.g. a screen load. Keep `transactionName` low-cardinality ("HomeScreen.load",
 * not one per item id): every distinct name is its own row.
 */
export function recordPerformance(transactionName: string, durationMs: number): void {
  getPerformanceFlusher().record(transactionName, durationMs);
}

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * Runs `fn`, records how long it took under `transactionName` (see recordPerformance), and returns
 * whatever `fn` returned. If `fn` returns a promise, times until it settles (fulfilled or
 * rejected) and returns a promise resolving or rejecting the same way. Recorded even if `fn` throws
 * (the error propagates unchanged): a call that fails is exactly one worth seeing on the
 * Performance page.
 *
 *     const user = await timeTransaction("HomeScreen.load", () => api.loadUser());
 */
export function timeTransaction<T>(transactionName: string, fn: () => T): T {
  const startedAt = now();
  const record = (): void => recordPerformance(transactionName, now() - startedAt);

  let result: T;
  try {
    result = fn();
  } catch (error) {
    record();
    throw error;
  }

  if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        record();
        return value;
      },
      (error: unknown) => {
        record();
        throw error;
      },
    ) as T;
  }

  record();
  return result;
}

/**
 * Delivers whatever has been tallied so far right now, instead of waiting for the next interval.
 * A mobile app is suspended shortly after it goes to the background and nothing is flushed then, so
 * call this from an AppState "background" listener (see README.md).
 */
export function flushPerformance(): Promise<void> {
  return getPerformanceFlusher().flush();
}

/**
 * Manually attaches an affected user to whatever gets reported from here on (an explicit
 * `captureException` call, the global `ErrorUtils` handler, or unhandled-rejection tracking):
 * there's no way to automatically detect "the current user" in React Native the way a server-side
 * web framework with its own session/auth middleware can, so call this yourself, e.g. right after
 * sign-in. `id`/`email`/`username` are all independently optional; call with `null` (or an empty
 * object) to clear whatever was set, e.g. on sign-out.
 */
export function setUser(user: Record<string, unknown> | null): void {
  currentUser = user && Object.keys(user).length > 0 ? user : null;
}

/**
 * Covers an uncaught JS exception with no further wiring needed, via `ErrorUtils`: React
 * Native's own global error hook, set up by the RN runtime itself before any app code runs (the
 * RN equivalent of `window.onerror`, for an environment with no `window`). Chains to whatever
 * handler was already installed (RN's own default, which logs to the console and shows the red
 * error screen in a debug build) rather than replacing it, the same "report, then don't change
 * program behavior" rule every other client in this repo follows for its own automatic-capture
 * path.
 */
function installGlobalErrorHandler(): void {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;

  if (typeof ErrorUtils === "undefined") {
    // Not actually running under React Native (a plain Node/test environment, most likely):
    // nothing to install, and nothing to fail loudly about either.
    return;
  }

  previousErrorHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    const err = error instanceof Error ? error : new Error(String(error));
    captureException(err, { fatal: Boolean(isFatal) });
    previousErrorHandler?.(error, isFatal);
  });
}

/**
 * Covers a rejected promise nobody attached a `.catch()` to: React Native has no
 * `window.unhandledrejection` event (there's no `window`), so this uses the same
 * `promise/setimmediate/rejection-tracking` module React Native's own internal Promise setup is
 * built on (ships as a transitive dependency wherever `react-native` itself is installed, so no
 * separate install is needed by a host app). Dynamically imported and wrapped in try/catch
 * deliberately: this is best-effort: an RN version whose internals have moved this module, or a
 * non-RN test environment where it doesn't resolve at all, should never make `init()` itself
 * throw over a nice-to-have.
 */
function installUnhandledRejectionTracking(): void {
  void import("promise/setimmediate/rejection-tracking")
    .then((rejectionTracking) => {
      rejectionTracking.enable({
        allRejections: true,
        onUnhandled: (_id: number, error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          captureException(err);
        },
      });
    })
    .catch(() => {
      // Not available in this environment: see this function's own doc comment.
    });
}

/** @internal not part of the public API: resets module state between test cases */
export function _resetForTesting(): void {
  if (typeof ErrorUtils !== "undefined" && previousErrorHandler) {
    ErrorUtils.setGlobalHandler(previousErrorHandler);
  }
  uninstallBreadcrumbs();
  stopHttpPerformance?.();
  stopHttpPerformance = null;
  performanceFlusher?.discard();
  performanceFlusher = null;
  stopHttpTracing?.();
  stopHttpTracing = null;
  spanQueue?.discard();
  spanQueue = null;
  metricBuffers?.custom.discard();
  metricBuffers?.infrastructure.discard();
  metricBuffers = null;
  openTraces.clear();
  configuration = null;
  reporter = null;
  breadcrumbBuffer = null;
  handlersInstalled = false;
  previousErrorHandler = null;
  currentUser = null;
}
