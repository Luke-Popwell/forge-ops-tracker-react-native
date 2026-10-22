# @forge-ops/tracker-react-native

React Native error tracking client for [ForgeOps](https://getforgeops.net): captures uncaught JS
exceptions (`ErrorUtils`) and unhandled promise rejections, plus explicit capture anywhere
else, and delivers them over HTTP.

> For health or personal data, turn on [strict privacy](#strict-privacy): the SDK then sends only structured facts about each error (its type, stack trace, release and route), never the message, a raw path, breadcrumbs, or context you haven't allowed.

React Native has no `window` at all, so there's no `window.onerror` or `unhandledrejection` event
to listen for; it has its own global error hook (`ErrorUtils`) instead, plus its own
unhandled-promise-rejection story, and no reliable equivalent of a filesystem or origin to compare
a backtrace frame's path against for `in_app` classification (see below): a release bundle is
one big minified file with app code and library code both in it. This client is built around those
specifics.

## Installation

```bash
npm install @forge-ops/tracker-react-native
```

`react-native` itself is a peer dependency (`>=0.70`), not bundled: your app already has it.

## Configuration

```ts
import * as forgeOpsTracker from "@forge-ops/tracker-react-native";

forgeOpsTracker.init({
  dsn: "https://<api_key>@getforgeops.net/api/v1/events",
  environment: "production",
});
```

Call `init` once, as early as possible: the top of your app's entry file (`index.js`), before
any other code runs, so the global handlers below are in place before anything else could throw.
There's no environment-variable auto-read here: a React Native bundle has no reliable,
bundler-agnostic equivalent of `process.env` at runtime, so the DSN must always be passed
explicitly.

## What gets reported automatically, and what doesn't

**An uncaught JS exception needs no further wiring at all.** `ErrorUtils` is React Native's own
global error hook, installed by the RN runtime itself before any app code runs: the RN
equivalent of `window.onerror`, for an environment with no `window`. This client chains to
whatever handler was already installed (RN's own default, which logs to the console and shows the
red error screen in a debug build) rather than replacing it, so reporting an error never changes
what your app actually does afterward.

**An unhandled promise rejection also needs no further wiring**, via the same
`promise/setimmediate/rejection-tracking` module React Native's own internal `Promise` setup is
built on: it ships as a transitive dependency wherever `react-native` itself is installed, so
nothing extra to install. This is genuinely best-effort: the import is dynamic and wrapped in a
`try`/`catch`, so an RN version whose internals have moved this module (or a non-RN environment,
like this package's own test suite) silently skips it rather than making `init()` itself throw
over a nice-to-have.

**An exception your own code catches and handles is different**: report it explicitly, right at
the catch site:

```ts
try {
  await chargeCard(order);
} catch (error) {
  forgeOpsTracker.captureException(error as Error, { orderId: order.id });
}
```

## Identifying users

```ts
forgeOpsTracker.captureException(error as Error, { orderId: order.id }, { id: user.id, email: user.email });
```

Or `setUser` to attach it to every subsequently reported error (an explicit `captureException`
call, an uncaught exception, an unhandled rejection) until changed or cleared, rather than passing
it to every call by hand, e.g. right after sign-in:

```ts
forgeOpsTracker.setUser({ id: user.id, email: user.email });
// on sign-out:
forgeOpsTracker.setUser(null);
```

There's no way to automatically detect "the current user" in React Native the way a server-side
web framework with its own session/auth middleware can, so this is always manual. A mobile app
install is effectively single-user (unlike a server handling many concurrent requests at once, the
reason `sdks/node`'s own equivalent needs `AsyncLocalStorage` instead), so this is a plain
module-level variable, not any kind of per-request storage. `id`/`email`/`username` are all
independently optional. Shows up on an issue's own detail page, and as its own affected-users
count alongside the regular event count.

## `in_app` backtrace frames: off by default, and why

A React Native **release** bundle is typically one single minified file (`index.android.bundle`/
`main.jsbundle`) covering the whole app plus every dependency: there's no meaningful filesystem
"app root" to compare a frame's path against, since app code and library code live in the exact
same file. `Configuration.inAppHeuristicEnabled` (default `false`) turns on a
`node_modules`-path-exclusion heuristic that's genuinely useful in a
**development** build (Metro's dev server keeps real, unminified per-file paths) but not reliable
in a release build, which is why it isn't on unless you explicitly ask for it.

## Backtrace parsing: a documented, not independently verified, assumption

The frame regex targets React Native's Hermes JS engine, which produces V8-compatible `Error#stack`
output specifically for tooling compatibility: a well-documented fact relied on by every major
React Native error tracker. No runnable Hermes VM was available in the
environment this was built in to independently confirm that format against a real captured stack
trace (only the ahead-of-time `hermesc` compiler, which does not execute scripts: confirmed
directly, not assumed). Treat this as the standard assumption every comparable library makes for
Hermes, not as independently verified the way a regex checked against a real runtime capture would
be: if you hit a real parsing gap against an actual device/simulator, that's the first place to
look.

## Source context (not implemented on React Native, by design): read this before setting `captureSourceContext`

`Configuration.captureSourceContext` exists (defaults to `true`) purely for API-shape consistency
with every other ForgeOps SDK, several of which do attach a few lines of source around an in-app
frame's culprit line, read straight off disk at capture time. **On React Native this option does
nothing: `EventBuilder`'s `attachSourceContext` is a documented no-op, always**, regardless of how
this flag is set. Setting it to `false` is harmless, but it isn't turning off a real feature:
there was never a read happening to turn off.

Two separate facts make a real implementation impossible here, not just difficult:

- This client's JS runtime is Hermes (or JSC in some configurations), never Node. There is no `fs`
  module, or any other filesystem API, reachable from a React Native app's JS bundle at all,
  without adding a native module, and this package has zero third-party dependencies (see
  "Dependencies" below).
- Even with filesystem access, a frame's `file` here is never a real path on the device's own
  filesystem: a release build's frames point into one single bundled/minified JS file
  (`index.android.bundle`/`main.jsbundle`), and a development build's frames point at a Metro
  dev-server URL, not a path any filesystem API could open. See "`in_app` backtrace frames" above
  for the same underlying gap.

If this ever becomes meaningful (e.g. a future integration with a native module that exposes real
filesystem access, for a development-only build), the window/truncation this client would use are
already fixed at the same values as every other ForgeOps SDK: 5 lines of source either side of the
culprit line, with any individual captured line truncated past 500 characters.

## Breadcrumbs

A small, bounded trail of recent events attached to whatever gets reported next, so an issue's
detail page can show what led up to it, not just the moment it happened. Two sources are captured
automatically once `init` runs, plus whatever you add by hand:

- **Console output**: `console.log`/`info`/`warn`/`error`/`debug`, each with its own level.
- **Network requests**: every `XMLHttpRequest` (with its method, URL, status, and duration). This
  covers `fetch` too, without wrapping it separately: React Native's global `fetch` is the
  `whatwg-fetch` polyfill, built on `new XMLHttpRequest()` (confirmed against the `react-native`
  0.87 source this package's own devDependencies install), so wrapping both would record every
  `fetch` twice. This client's own delivery requests are never recorded, so a reported error never
  leaves a breadcrumb behind for itself.
- **Your own**, for anything else, e.g. a screen change from your navigation library's callback
  (there's no `window`/`history` in React Native, and navigation is whatever library you chose, so
  `sdks/typescript`'s navigation and click sources have no generic equivalent here):

```ts
forgeOpsTracker.addBreadcrumb({ category: "navigation", message: "Home -> Checkout" });
forgeOpsTracker.addBreadcrumb({ category: "payment", message: "charging card", level: "info", data: { orderId: order.id } });
```

`category` defaults to `"custom"` and `level` to `"info"` (unlike `sdks/typescript`, where both are
required). Only the 30 most recent (`maxBreadcrumbs`) are kept, oldest dropped first; pass
`breadcrumbs: false` to `init` to turn the automatic sources off (`addBreadcrumb` still works). A
single console line or URL is capped at 500 characters. `message` and `data` are PII-scrubbed like
the rest of the payload; `category`, `level`, and `timestamp` never are. Omitted from the payload
entirely when the trail is empty.

One shared trail for the whole app, never cleared after a report (the trail leading up to one
error is still what's relevant if another comes moments later): a mobile app is effectively
single-flow and React Native's JS runs on one thread, so there is nothing to lock or scope. Call
`clearBreadcrumbs()` to start a new logical unit of work (a new sign-in session, say) with a fresh
one. Because delivery here is in-memory (see below), the trail is not persisted to disk either.

## Performance monitoring

Times work and reports one small aggregate per transaction (how many times it ran, total and maximum
duration) every `performanceFlushIntervalMs` (60s by default), for the Performance page's
per-transaction table. Not one network call per timed call. On by default; turn it all off with
`trackPerformance: false`. Two sources:

Each aggregate also carries a small latency histogram (a count per fixed latency bucket: 50, 100,
250, 500, 1000, 2500, 5000 and 10000ms, plus an overflow bucket), so ForgeOps can show an
approximate p50/p95/p99 per transaction, not just an average. Percentiles are accurate to the width
of whichever bucket a duration falls into; the SDK never stores the individual durations.

- **Every network request, automatically**, timed under `METHOD host` (e.g. `GET api.example.com`),
  never the full URL: a path with an id in it would give every distinct id its own row, and a host is
  the granularity that is always low-cardinality. This wraps `XMLHttpRequest`, which sees every
  `fetch`, axios call, and hand-written XHR (React Native's `fetch` is built on it; see
  "Breadcrumbs" above), and it shares one patch with the breadcrumb network source rather than
  wrapping it twice. This client's own delivery requests (events *and* performance_samples) are
  never timed.
- **Your own**, for anything else you want on the Performance page, e.g. a screen load. Keep names
  low-cardinality (`"HomeScreen.load"`, not one per item id):

```ts
const user = await forgeOpsTracker.timeTransaction("HomeScreen.load", () => api.loadUser());
forgeOpsTracker.recordPerformance("checkout", elapsedMs); // or a duration you measured yourself
```

`timeTransaction` returns whatever the function returned; if that is a promise it times until the
promise settles (fulfilled or rejected). It records even if the function throws, and the error
propagates unchanged.

The timer is a `setTimeout` chain, started on the first recorded duration and re-armed only while
there is something left to send, so it never idles. But **a mobile app is suspended shortly after it
goes to the background and nothing is flushed then**, so call `forgeOpsTracker.flushPerformance()`
from an `AppState` listener yourself, or the last window is lost:

```ts
AppState.addEventListener("change", (state) => {
  if (state === "background") void forgeOpsTracker.flushPerformance();
});
```

A delivery that fails for now (a network error, a timeout, a 5xx, a 408 or a 429) keeps every
tally, so the next flush's window just grows; after 5 flushes in a row have failed, the batch is
dropped and the tallies start clean. A batch the server rejects (any other 4xx) is dropped at once
and never sent again. What a flush delivered
is *subtracted* from the tallies afterward, never the whole map cleared: a record that lands while
the network call is in flight would otherwise be silently discarded, a real bug `sdks/go` had and
fixed and that `gems/forge_ops_tracker`'s reference implementation still has. A deterministic test
pins this.

## Distributed tracing

One flow's own call tree (a screen load, a sign-in, a network round trip and what it triggered),
shown as a span tree on ForgeOps. A trace is sent only when the whole flow took at least
`traceCaptureThresholdMs` (1000 by default), so fast flows cost nothing on the wire. On by default;
turn it off with `trackTracing: false`. A trace can continue into your backend: see "Following a
request into your backend" below.

```ts
import { trace, startTrace, flushSpans } from "@forge-ops/tracker-react-native";

const feed = await trace("HomeScreen.load", async (t) => {
  const items = await t.span("fetch feed", () => api.fetchFeed(), { kind: "http" });
  return t.span("decode", () => decode(items), { data: { count: items.length } });
});

// Or hold the trace across the flow and finish it when it ends:
const t = startTrace("Checkout");
t.recordSpan("charge", { kind: "http", startedAt: started, durationMs: elapsed });
t.finish();
```

**Automatic:** every network request made while exactly one trace is open is recorded into it as an
`http` span named `METHOD host` (never the path or query), through the same `XMLHttpRequest` patch
breadcrumbs and network timing share. With two or more traces open at once there is no way to know
which one a request belongs to, so it is left out rather than guessed; this client's own requests
are never recorded. Everything else is a span you add by hand.

React Native has no async-context storage (unlike `sdks/node`'s `AsyncLocalStorage`), so **nesting is
explicit**: a span's callback receives the scope to nest children under, which stays correct across
`await`s and for children started in parallel. `span` returns what its callback returned (a promise
if it returned one), records even when the callback throws or rejects, and `trace` finishes the same
way. `kind` is one of `controller`, `service`, `database`, `redis`, `http`, `job`, `other` (anything
else is sent as `other`, since the server rejects a whole trace over one unknown kind). A trace holds
at most 500 spans. When tracing is off or reporting isn't enabled, `startTrace` returns a disabled
trace on which everything is a no-op (the callback still runs), so callers never check. A trace you
start yourself must be finished, or it stays open and makes automatic attribution ambiguous.

Delivery is in-memory and async, like the error queue: a trace queued right before the app is killed
can be lost, so call `flushSpans()` from an `AppState` `"background"` listener.

### Database spans with their SQL

A `database` span can carry the SQL it ran (a query against the app's local SQLite database, say)
and which database it was. Every string and number literal is replaced by `?` before it leaves the
device (so `WHERE email = 'a@b.co'` is sent as `WHERE email = ?`), the statement is cut at 4000
characters, and ForgeOps masks it again on arrival. It is sent in the span's data as `db.statement`
and `db.system`, and ForgeOps shows it on the span. Both options are ignored on any other kind.

Masking covers strings with `''` or backslash-escaped quotes (`'o\'brien'`), prefixed strings
(`E'...'`, `X'DEADBEEF'`, `N'...'`, `B'...'`, `U&'...'`), `$tag$` dollar-quoted bodies, and hex,
binary, exponent and leading-dot numbers (`0x1F`, `0b101`, `1.5E-3`, `.5`), but never the digits in
a name like `orders2` or a `$1` placeholder. With `dbSystem` set to `"mysql"` or `"mariadb"`,
`"double quoted"` values are masked too; for any other database they're names, and are left as
written.

```ts
const sql = "SELECT * FROM messages WHERE thread_id = 42 AND read = 0";
const messages = await t.span("Load messages", () => db.getAllAsync(sql), {
  kind: "database",
  statement: sql,
  dbSystem: "sqlite",
});
// Sent as db.statement "SELECT * FROM messages WHERE thread_id = ? AND read = ?", db.system "sqlite".
```

`recordSpan` takes the same `statement` and `dbSystem` options for a query you timed yourself.

### Following a request into your backend

Traces use the [W3C Trace Context](https://www.w3.org/TR/trace-context/) standard (ids are 32 and 16
lowercase hex characters), so a failed request in the app can be linked to the backend request it
caused:

- **Automatic:** every request made while exactly one trace is open gets a
  `traceparent: 00-<trace id>-<span id>-01` header whose span id is that request's own `http` span,
  so the backend's spans nest under it. A `traceparent` you set yourself is never replaced, and this
  client's own requests to ForgeOps never get one.
- **Explicit:** `t.fetch(input, init)` calls `fetch` with the header added and records the call as
  an `http` span; `t.httpSpan(method, url)` returns `{ headers, end(status?) }` for any other HTTP
  client. Both also work on the scope a `span` callback receives, nesting the call under that span.
- **Errors:** an error captured while exactly one trace is open is sent with that trace's id
  (`t.traceId`), which is what connects it to the backend's error for the same request. An error
  captured outside a trace is sent exactly as before.

```ts
import { startTrace, captureException } from "@forge-ops/tracker-react-native";

async function placeOrder(cart: Cart): Promise<void> {
  const t = startTrace("Checkout");
  try {
    const response = await t.fetch("https://api.example.com/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cart),
    });
    if (!response.ok) {
      throw new Error(`Checkout failed with ${response.status}`);
    }
  } catch (error) {
    captureException(error as Error, { cartId: cart.id }); // sent with t.traceId
    throw error;
  } finally {
    t.finish();
  }
}
```

The backend must also report to ForgeOps (the Ruby SDK continues the trace automatically from
0.12.0), and the two projects must be linked in ForgeOps to see the app's error and the backend's
error connected.

Two options control where the header goes, for example if a third-party API rejects headers it
doesn't know:

```ts
forgeOpsTracker.init({
  dsn: "...",
  propagateTraces: false, // never send traceparent (default true)

  // Default undefined: every host. A string matches that host and its subdomains on a dot boundary
  // ("example.com" matches "api.example.com", not "badexample.com"); a RegExp is tested against
  // the host, without the port.
  tracePropagationTargets: ["example.com", /^10\.0\.2\.2$/],
});
```

Both apply to the explicit `t.fetch`/`t.httpSpan` as well; the `http` span is still recorded when no
header is sent. With `trackTracing: false`, or reporting not enabled, no header is sent and no error
carries a trace id, since `startTrace` returns a disabled trace.

## Custom metrics and infrastructure monitoring

Two explicit calls (nothing is automatic, so there is no `trackMetrics` flag): a business event you
name yourself, and a reading from a device or one of your own hosts.

```ts
import { captureMetric, captureInfrastructureMetric, flushMetrics } from "@forge-ops/tracker-react-native";

captureMetric("purchase"); // value defaults to 1: a bare counter
captureMetric("iap_revenue", 4.99); // a real magnitude; it may be negative (a refund)

captureInfrastructureMetric("battery", 0.42, { hostname: "device-1" });
await flushMetrics(); // send right now
```

Each capture is buffered and flushed as one batch every `metricFlushIntervalMs` /
`infrastructureMetricFlushIntervalMs` (60,000 by default) on a `setTimeout` chain. A mobile app is
suspended shortly after it goes to the background and nothing is flushed then, so call
`flushMetrics()` from an `AppState` `"background"` listener. Every entry is stored as it was captured (a
purchase is a row, not a running total), so a count or sum you compute later is exact. Both are a no-op
when reporting isn't enabled for the environment.

**Infrastructure readings need a hostname**, and a phone has none: pass `{ hostname }` or set
`serverName` in `init` (it is `null` by default, and a reading without one is dropped with a log line rather than sent).

A delivery that fails for now (a network error, a timeout, a 5xx, a 408 or a 429) keeps every entry
for the next flush, and an entry captured while a delivery is in flight is kept too (the Ruby gem's own
buffer loses it; a test pins this with a gated delivery: a flush awaits the network, so captures really
do interleave with it). After 5 flushes in a row have failed, the batch is dropped and the buffer starts
clean. A batch the server rejects (any other 4xx, such as the 403 a plan without the feature answers) is
dropped at once and never sent again. Each buffer holds at most 1000 entries and drops further ones
until a flush empties it. A NaN or infinite value is dropped at capture:
`JSON.stringify` turns it into `null`. Requires a ForgeOps plan that includes custom metrics /
infrastructure monitoring.

## Recording changes

When a feature flag flips or a remote config value changes, tell ForgeOps, and it shows the change on
the timeline next to the errors around it, so "crashes started right after `new_checkout` turned on"
is one glance instead of an investigation. Call `recordChange` from your flag or config client's
change callback:

```ts
import * as forgeOpsTracker from "@forge-ops/tracker-react-native";

forgeOpsTracker.init({ dsn: "https://<api_key>@getforgeops.net/api/v1/events" });

// Your flag client's change listener: whatever it calls with the key and the old and new values.
flagClient.on("change", (key: string, value: boolean, previous: boolean) => {
  forgeOpsTracker.recordChange("feature_flag", `${key} turned ${value ? "on" : "off"}`, {
    details: { key, from: previous, to: value },
    actor: "flag-service",
  });
});
```

`kind` is one of `"feature_flag"`, `"config"`, `"migration"`, `"dependency"`, `"infrastructure"`, or
`"other"` (exported as `CHANGE_KINDS`); anything else is sent as `"other"`. The title is required and
cut to 200 characters. Optional: `details` (a small JSON object), `environment` (defaults to the
configured one), `service`, `actor`, `url` (http or https), `id` (an idempotency key, so recording
the same change twice keeps one), and `occurredAt` (a `Date` or ISO 8601 string, default now).

The change is sent right away in the background: `recordChange` returns immediately and never throws,
whether the request fails or your plan doesn't include change tracking (that 403 is silent). Like
every other call, it's a no-op when reporting isn't enabled for the environment.

## Delivery: in-memory only, not durable

`DeliveryQueue` is a small in-memory bounded queue drained by an async processing loop, so
delivery never blocks the code that raised the error: `push()` returns immediately, and delivery
happens over non-blocking `fetch()` calls. This is purely in-memory, not disk-backed: an event
queued right before the app is killed (by the OS, or by the same crash it's trying to report) can
be lost. A real, documented limitation, not a hidden one: adding a durable on-disk queue (e.g.
via `@react-native-async-storage/async-storage` or a native module) is a reasonable follow-up, not
something this round implements.

## PII scrubbing

By default, the message, backtrace, and any context you attach are scanned for likely personal
data (email addresses, formatted SSNs/credit cards, known API key/token formats, and anything
under a suspiciously-named key like `password`, `api_key`, or `ssn`) and redacted before
the payload ever leaves the device. ForgeOps itself scrubs again on arrival regardless, so this is
a second, earlier layer, not the only one. The user attached via `captureException`'s third
argument or `setUser` above is a deliberate exception: it's never scrubbed, since redacting it
would defeat the whole point of identifying users in the first place.

To disable it: `forgeOpsTracker.init({ dsn: "...", scrubPii: false })`.

## Strict privacy

For apps that can't let personal or health data (PII, PHI) leave the device. With strict privacy
on, this client sends only structured facts about an error, never free text that could carry a
name, an email or a diagnosis:

```ts
forgeOpsTracker.init({
  dsn: "...",
  strictPrivacy: true,
  privacyAllowedFields: ["error_code", "feature"],
});
```

- An error event goes out without its message. It carries a `message_fingerprint` instead: a
  one-way hash of the message (as it would have been sent, so after PII scrubbing) with its
  numbers, ids, emails and quoted values taken out, computed on the device, so errors still group the same way.
- No breadcrumbs (none are recorded, automatic or `addBreadcrumb()`) and no SQL statement (even with
  `captureSqlStatement` on; the table and procedure names are still sent). There's no source
  context or session replay on React Native to begin with.
- The user is sent as its `id` only, never `email` or `username`.
- Context and tags keep only the top-level keys listed in `privacyAllowedFields`, and only when the
  value is a string, number or boolean. With none listed, neither is sent.
- Traces: a network span is named by its method and host (`GET api.example.com`), a span named
  after a path follows the path rule below, and span data keeps only `db.statement` (already
  masked) and `db.system`.
- A performance sample's transaction name that's a path follows the path rule below; any other name
  is kept.
- Paths: a route template (`/patients/:id/notes`, `/patients/{id}`, `/files/*path`) is kept as it
  is. A raw path keeps only its first segment, the rest becomes `:path`
  (`/patients/jane-doe/12` is `/patients/:path`), and a first segment holding a digit becomes `:id`.

The exception class, backtrace frames (file, line, function), release, environment and trace id are
unchanged, as are performance aggregates, metrics and recorded changes. Both options are set in
`init()` only: a React Native bundle has no environment to read them from.

ForgeOps applies the same rules again on arrival when the project's own Strict privacy setting is
on, so an app running an older client, or one configured without this, still can't get text stored
for that project.

## Database errors

React Native apps rarely run SQL against a server, but an on-device SQLite library's error can carry the statement as a `.sql` or `.query` string, which is read automatically. Where it doesn't, attach it where you ran the query with `withSql`, and the event includes the names of the tables and views that SQL touched, so the issue tells you where to start looking. Names are identifiers, never values; the raw statement never leaves the process.

To also send the SQL statement itself, opt in. Every string and number is replaced by `?` before it
leaves your process (`WHERE email = 'a@b.co' AND id = 42` is sent as `WHERE email = ? AND id = ?`),
and ForgeOps masks it again on arrival:

```ts
import { withSql } from "@forge-ops/tracker-react-native";

try {
  await db.executeSql(sql, params);
} catch (error) {
  throw withSql(error as Error, sql);
}

// Opt in to also sending the masked statement (default false).
forgeOpsTracker.init({ dsn: "...", captureSqlStatement: true });
```

Each ForgeOps project also has its own "Capture the SQL behind database errors" setting. Turn it off
there and the statement is never stored for that project, whatever this flag says; the names are
still kept. A view and a table are written the same way in SQL, so both show as tables/views; the
database's own error message usually settles which it was.

## Running the tests

```bash
cd sdks/reactnative
npm install
npm test
npm run lint
```

Runs under Node/vitest, not a real React Native runtime or simulator: `ErrorUtils` and `fetch`
are mocked directly in `test/index.test.ts`/`test/client.test.ts`, the same way a real RN app's
own Jest test environment (no browser, no device) works. See "Backtrace parsing" above for what
that does and doesn't verify.
