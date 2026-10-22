/**
 * Holds a single ForgeOps DSN plus everything else the client needs to build and deliver events.
 * Mirrors sdks/typescript/src/configuration.ts's shape (no auto-read from an environment
 * variable: a React Native bundle has no reliable equivalent of process.env at runtime any more
 * than a browser bundle does, so the DSN must always be passed explicitly to init()).
 *
 * DSN parsing here is hand-rolled string splitting rather than `new URL(...)`, unlike the
 * browser client: older React Native / Hermes releases shipped with no global `URL` at all
 * (needing a polyfill package), and this client has no way to know which RN version a host app is
 * on. The shape is fixed and simple enough ("scheme://api_key@host/path") that a small
 * dependency-free parser is clearer here than requiring a URL polyfill, the same spirit as the
 * Rust/Go/C clients' own dependency-free DSN parsing.
 */
export class Configuration {
  dsn: string | null = null;
  environment = "production";
  release: string | null = null;

  /** There's no meaningful "server_name" on a mobile device the way there is for a server
   * process: left null by default; a host app can set it to a device/build identifier if
   * useful. */
  serverName: string | null = null;

  /**
   * Used to decide whether a backtrace frame is "in_app": a frame's file path is checked for
   * `/node_modules/`, the same heuristic sdks/node's own Configuration#appRoot pairing uses:
   * see EventBuilder's own comment for why a stronger check (comparing against a real app root)
   * isn't meaningfully possible in a bundled React Native app the way it is in Node. Off (every
   * frame reported as not-in-app) unless explicitly enabled, since a production release bundle's
   * paths are typically meaningless anyway (see README.md).
   */
  inAppHeuristicEnabled = false;

  /**
   * Whether EventBuilder attempts to read a few lines of source off disk around an in-app frame's
   * culprit line and attach them to that frame (see eventBuilder.ts's own `attachSourceContext`).
   * Defaults to `true`, mirroring every other ForgeOps SDK: the durable protection against
   * literal source text leaving a device isn't this flag at all, it's the per-project setting on
   * the ForgeOps server itself, which overrides whatever any given SDK instance has configured
   * locally regardless of what this is set to here.
   *
   * On React Native specifically, this option exists purely for API-shape consistency with every
   * other ForgeOps SDK: `attachSourceContext` is a documented no-op here, always. See that
   * function's own comment and README.md's "Source context" section for why: in short, this
   * client's JS runtime (Hermes/JSC, not Node) has no filesystem module at all, and even the
   * `file` this client already records for a frame is a bundle-relative virtual path or a Metro
   * dev-server URL, never a real path on the device's own filesystem, so there is nothing this
   * flag could ever gate a real disk read against in the first place.
   */
  captureSourceContext = true;

  /**
   * When an error carries the SQL behind a failed database call (Sequelize, TypeORM, mysql2, and
   * anything that wraps one; see sqlStatement.ts), send the names of the stored procedure, table
   * and view it touched, so an issue says where to start looking. Names are identifiers, never
   * values, which is why this defaults on. captureSqlStatement is the separate, opt-in step of also
   * sending the statement itself, with every string and number replaced by "?"; off by default
   * because even a masked statement describes your schema, and ForgeOps' own per-project setting
   * is what durably governs whether the server stores it.
   */
  captureSqlObjects = true;
  captureSqlStatement = false;

  /**
   * Whether init() installs the automatic breadcrumb sources (console output and network
   * requests); see breadcrumbs.ts. On by default, the same "on unless you turn it off" posture
   * error reporting itself already has. addBreadcrumb() in index.ts still works with this off:
   * this flag only gates the automatic sources.
   */
  breadcrumbs = true;

  /** How many recent breadcrumbs are kept; the oldest is dropped once this is exceeded. */
  maxBreadcrumbs = 30;

  /**
   * Whether the automatic network timing (see performanceFlusher.ts's installHttpPerformance) and
   * recordPerformance()/timeTransaction() in index.ts time anything at all. On by default, the same
   * "on unless you turn it off" posture error reporting itself already has.
   */
  trackPerformance = true;

  /** How often the in-process tallies are flushed as one small aggregate report, in milliseconds, rather than one network call per timed call. 60s, matching gems/forge_ops_tracker's own default. */
  performanceFlushIntervalMs = 60_000;

  /**
   * Whether startTrace()/trace() in index.ts start a trace at all, and so whether spans are recorded
   * and slow traces sent. On by default. Only network requests are recorded automatically (see
   * tracing.ts); everything else is a span you add by hand.
   */
  trackTracing = true;

  /** A trace is only sent when its root took at least this many milliseconds. 1s, matching every other client's default. */
  traceCaptureThresholdMs = 1000;

  /**
   * Whether a request made inside a trace carries a W3C `traceparent` header, so a backend that
   * reports to ForgeOps too continues the same trace (see tracing.ts). On by default, matching
   * gems/forge_ops_tracker's propagate_traces. Turn it off, or narrow it with
   * tracePropagationTargets, if a third-party API rejects headers it doesn't know.
   */
  propagateTraces = true;

  /**
   * Which hosts get the `traceparent` header. Undefined (the default) means every host. A string
   * matches that host and its subdomains on a dot boundary ("example.com" matches
   * "api.example.com", not "badexample.com"); a RegExp is tested against the host (no port).
   */
  tracePropagationTargets: (string | RegExp)[] | undefined = undefined;

  /**
   * Milliseconds between flushes of the buffered captureMetric()/captureInfrastructureMetric() entries
   * (see metricBuffer.ts). There is no trackMetrics flag the way trackPerformance has one: these are
   * explicit calls the host app's own code makes, not automatic instrumentation, so there is nothing to
   * turn off that simply not calling them doesn't already do.
   */
  metricFlushIntervalMs = 60_000;
  infrastructureMetricFlushIntervalMs = 60_000;

  enabledEnvironments = new Set(["production", "staging"]);
  queueSize = 1000;
  timeoutMs = 5000; // longer than the browser client's 2s default: a mobile network connection is far more likely to be slow/flaky than a desktop one
  scrubPii = true;

  /**
   * Strict privacy, for apps that can't let personal or health data leave the device: every error
   * event goes out without its message (a message_fingerprint instead, so errors still group),
   * breadcrumbs, SQL statement, or the user's email/username, and with only the context/tag keys
   * named in privacyAllowedFields. Breadcrumbs aren't recorded at all, network spans are named by
   * method and host only, and span data keeps only db.statement and db.system. See
   * strictPrivacy.ts. Off by default. ForgeOps applies the same rules again on arrival when the
   * project's own Strict privacy setting is on.
   */
  strictPrivacy = false;

  /**
   * Context and tag keys strict privacy still sends (only plain string, number or boolean values
   * under these exact top-level keys), e.g. ["error_code", "feature"]. None by default.
   */
  privacyAllowedFields: string[] = [];

  logger: ((message: string) => void) | null = null;

  apiKey(): string | null {
    const parsed = this.parsedDsn();
    if (parsed === null || parsed.userinfo === "") {
      return null;
    }
    return decodeURIComponent(parsed.userinfo);
  }

  /** The ingestion URL with credentials stripped out (they travel as the Authorization header instead). */
  ingestionUri(): string | null {
    const parsed = this.parsedDsn();
    if (parsed === null) {
      return null;
    }
    return `${parsed.scheme}://${parsed.hostAndPath}`;
  }

  /**
   * Same derivation as ingestionUri(), with the trailing "/events" swapped for
   * "/performance_samples": one DSN, two endpoints, matching the Ruby gem's own
   * Configuration#performance_samples_uri.
   */
  performanceSamplesUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    return uri.endsWith("/events") ? `${uri.slice(0, -"/events".length)}/performance_samples` : uri;
  }

  /** Same derivation again, swapping the trailing "/events" for "/custom_metrics". */
  customMetricsUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    return uri.endsWith("/events") ? `${uri.slice(0, -"/events".length)}/custom_metrics` : uri;
  }

  /** Same derivation again, swapping the trailing "/events" for "/infrastructure_metrics". */
  infrastructureMetricsUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    return uri.endsWith("/events") ? `${uri.slice(0, -"/events".length)}/infrastructure_metrics` : uri;
  }

  /** Same derivation again, swapping the trailing "/events" for "/spans". */
  spansUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    return uri.endsWith("/events") ? `${uri.slice(0, -"/events".length)}/spans` : uri;
  }

  /** Same derivation again, swapping the trailing "/events" for "/changes" (see recordChange in index.ts). */
  changesUri(): string | null {
    const uri = this.ingestionUri();
    if (uri === null) {
      return null;
    }
    return uri.endsWith("/events") ? `${uri.slice(0, -"/events".length)}/changes` : uri;
  }

  /** Whether a request to `host` may carry a `traceparent` header: see propagateTraces/tracePropagationTargets. Case-insensitive, since hostnames are. */
  propagatesTraceTo(host: string): boolean {
    if (!this.propagateTraces) {
      return false;
    }
    if (this.tracePropagationTargets === undefined || this.tracePropagationTargets === null) {
      return true;
    }
    const normalized = host.toLowerCase();
    return this.tracePropagationTargets.some((target) => {
      if (target instanceof RegExp) {
        target.lastIndex = 0; // a /g or /y pattern would otherwise carry state from the last test
        return target.test(normalized);
      }
      const suffix = target.toLowerCase();
      return normalized === suffix || normalized.endsWith(`.${suffix}`);
    });
  }

  isEnabled(): boolean {
    return Boolean(this.dsn) && this.apiKey() !== null && this.enabledEnvironments.has(this.environment);
  }

  log(message: string): void {
    this.logger?.(message);
  }

  private parsedDsn(): { scheme: string; userinfo: string; hostAndPath: string } | null {
    if (!this.dsn) {
      return null;
    }
    const schemeSep = this.dsn.indexOf("://");
    if (schemeSep <= 0) {
      return null;
    }
    const scheme = this.dsn.slice(0, schemeSep);
    const rest = this.dsn.slice(schemeSep + 3);

    const at = rest.indexOf("@");
    const userinfo = at >= 0 ? rest.slice(0, at) : "";
    const hostAndPath = at >= 0 ? rest.slice(at + 1) : rest;
    if (!hostAndPath) {
      return null;
    }
    return { scheme, userinfo, hostAndPath };
  }
}
