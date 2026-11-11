import { Breadcrumb } from "./breadcrumbs.js";
import { Configuration } from "./configuration.js";
import * as sqlStatement from "./sqlStatement.js";
import { scrub, scrubString, Scrubbable } from "./piiScrubber.js";
import * as strictPrivacy from "./strictPrivacy.js";

const MAX_FRAMES = 500;

// Identifies this client to the server's auto language-detection on the project the event lands
// in (see Project#note_sdk_platform server-side); matches this repo's own sdks/reactnative
// directory name, the same convention every other language's client follows.
const SDK_NAME = "reactnative";

export interface BacktraceFrame {
  file: string | null;
  line: number | null;
  method: string | null;
  in_app: boolean;
  context_line?: string;
  pre_context?: string[];
  post_context?: string[];
}

export interface EventPayload {
  exception_class: string;
  message: string;
  backtrace: BacktraceFrame[];
  occurred_at: string;
  environment: string;
  release: string | null;
  server_name: string | null;
  context: Record<string, unknown>;
  tags: Record<string, unknown>;
  sdk_name: string;
  sql_objects?: sqlStatement.SqlObjects;
  sql_statement?: string;
  user?: Record<string, unknown>;
  // The W3C trace id of the trace open when this was captured (see tracing.ts), which ForgeOps uses
  // to link it to errors from linked projects in the same request. Omitted when there was none.
  trace_id?: string;
  // Omitted entirely (never sent as an empty array) when there's nothing to report.
  breadcrumbs?: Breadcrumb[];
}

/**
 * What an error event carries with Configuration#strictPrivacy on (see strictPrivacy.ts): no
 * message (message_fingerprint instead), breadcrumbs or SQL statement; context and tags only when
 * an allowed key is left; the user as its id only.
 */
export type StrictEventPayload = Omit<EventPayload, "message" | "breadcrumbs" | "sql_statement" | "context" | "tags" | "user"> & {
  message_fingerprint: string;
  context?: Record<string, strictPrivacy.AllowedValue>;
  tags?: Record<string, strictPrivacy.AllowedValue>;
  user?: { id: string };
};

// Same V8-style stack line format sdks/typescript/src/eventBuilder.ts parses (a leading "at",
// an optional "async" marker, an optional function name before "(", then "file:line:col"),
// e.g. "    at ChargeService.chargeCard (index.android.bundle:5:1234)". React Native's Hermes
// engine is documented (by Meta/React Native itself, and relied on by every major RN error-
// tracking SDK) to produce V8-compatible Error#stack output specifically for
// tooling compatibility like this. IMPORTANT CAVEAT, unlike every regex the sibling SDKs in this
// repo rely on: this specific one was NOT independently re-verified against a real
// Hermes-executed stack trace in this session: no Hermes runtime (only the ahead-of-time
// `hermesc` compiler, which does not execute scripts) was available in this environment to
// capture one from. Treat this as "the well-documented standard assumption," not "verified
// directly" the way this repo's other clients' own frame regexes are documented to be: see
// README.md's "Verification status" section.
const FRAME_RE = /^\s*at\s+(?:(async)\s+)?(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;

/**
 * Turns a raised exception into the payload shape the ingestion API expects. Ported from
 * gems/forge_ops_tracker/lib/forge_ops_tracker/event_builder.rb: backtrace parsing here is a
 * regex over Error#stack, the same general approach sdks/typescript/sdks/node use for their own
 * JS engines (V8), since React Native/Hermes exposes no structured frame list any more than those
 * do.
 *
 * Also calls attachSourceContext (see that function's own comment) for every frame: a
 * deliberate, documented no-op on this platform, always. It exists only so
 * Configuration.captureSourceContext stays real, working API surface, matching every other
 * ForgeOps SDK, even though this one can never act on it.
 */
export class EventBuilder {
  private configuration: Configuration;

  constructor(configuration: Configuration) {
    this.configuration = configuration;
  }

  build(
    error: Error,
    context: Record<string, unknown> = {},
    user?: Record<string, unknown> | null,
    breadcrumbs: Breadcrumb[] = [],
    traceId: string | null = null,
  ): EventPayload {
    const payload: EventPayload = {
      exception_class: error?.name ?? "Error",
      message: error?.message ?? "",
      backtrace: this.backtrace(error),
      occurred_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      environment: this.configuration.environment,
      release: this.configuration.release,
      server_name: this.configuration.serverName,
      context: { ...context },
      tags: {},
      sdk_name: SDK_NAME,
      ...(breadcrumbs.length > 0 ? { breadcrumbs } : {}),
    };

    this.attachSql(payload, error);
    const built = this.configuration.scrubPii ? this.scrub(payload) : payload;

    // Attached after scrubbing, deliberately never passed through it: a structured field the
    // host app sets deliberately, not free text that could accidentally spill sensitive data,
    // the same exemption exception_class/environment/release/server_name already get. Redacting
    // it would defeat the whole point of identifying users in the first place.
    if (user && Object.keys(user).length > 0) {
      built.user = user;
    }
    // Also never scrubbed: an id this client generated, not text from the app.
    if (traceId) {
      built.trace_id = traceId;
    }
    return built;
  }

  /**
   * The same event with strict privacy's rules applied (see StrictEventPayload). The fingerprint is
   * taken from the message as it would otherwise have been sent (scrubbed, when scrubPii is on), so
   * it matches what the server fingerprints from a client without strict privacy. Frames never
   * carry source context on this platform (see attachSourceContext), so there's none to drop.
   */
  buildStrict(error: Error, context: Record<string, unknown> = {}, user?: Record<string, unknown> | null, traceId: string | null = null): StrictEventPayload {
    const built = this.build(error, context, null, [], traceId);
    const allowed = this.configuration.privacyAllowedFields ?? [];
    const payload: StrictEventPayload = {
      exception_class: built.exception_class,
      backtrace: built.backtrace,
      occurred_at: built.occurred_at,
      environment: built.environment,
      release: built.release,
      server_name: built.server_name,
      sdk_name: built.sdk_name,
      message_fingerprint: strictPrivacy.messageFingerprint(built.message),
    };
    if (built.sql_objects) {
      payload.sql_objects = built.sql_objects;
    }
    if (built.trace_id) {
      payload.trace_id = built.trace_id;
    }
    const allowedContext = strictPrivacy.allowedFields(built.context, allowed);
    if (allowedContext) {
      payload.context = allowedContext;
    }
    const allowedTags = strictPrivacy.allowedFields(built.tags, allowed);
    if (allowedTags) {
      payload.tags = allowedTags;
    }
    const strictUser = strictPrivacy.userId(user, this.configuration.privacyUserKey);
    if (strictUser) {
      payload.user = strictUser;
    }
    return payload;
  }

  // exception_class/occurred_at/environment/release/server_name are left alone: structured
  // fields this client or the host app sets deliberately, not free text an exception or its
  // context could accidentally spill sensitive data into.
  private scrub(payload: EventPayload): EventPayload {
    return {
      ...payload,
      message: scrubString(payload.message),
      backtrace: payload.backtrace.map((frame) => ({
        ...frame,
        file: frame.file ? scrubString(frame.file) : frame.file,
        method: frame.method ? scrubString(frame.method) : frame.method,
      })),
      // A breadcrumb's message and data are free text (console output, a URL, whatever the host
      // app wrote); its category, level, and timestamp are structured values set deliberately, so
      // they are left alone, the same split as the top-level fields above.
      ...(payload.breadcrumbs
        ? {
            breadcrumbs: payload.breadcrumbs.map((breadcrumb) => ({
              ...breadcrumb,
              message: scrubString(breadcrumb.message),
              ...(breadcrumb.data ? { data: scrub(breadcrumb.data as Scrubbable) as Record<string, unknown> } : {}),
            })),
          }
        : {}),
      context: scrub(payload.context as Scrubbable) as Record<string, unknown>,
      tags: scrub(payload.tags as Scrubbable) as Record<string, unknown>,
      ...(payload.sql_statement !== undefined ? { sql_statement: scrubString(payload.sql_statement) } : {}),
    };
  }

  // See sqlStatement.ts for what's read off the error and how it's masked. The statement itself
  // only goes out when captureSqlStatement is on; the extracted names go out on their own
  // (captureSqlObjects) so an issue can still name the procedure or view involved.
  private attachSql(payload: EventPayload, error: Error): void {
    const config = this.configuration;
    if (!config.captureSqlObjects && !config.captureSqlStatement) {
      return;
    }

    const masked = sqlStatement.mask(sqlStatement.findIn(error));
    if (masked === null) {
      return;
    }

    const found = sqlStatement.objects(masked);
    if (found && config.captureSqlObjects) {
      payload.sql_objects = found;
    }
    if (config.captureSqlStatement) {
      payload.sql_statement = masked;
    }
  }

  private backtrace(error: Error): BacktraceFrame[] {
    const stack = typeof error?.stack === "string" ? error.stack : "";
    const frames: BacktraceFrame[] = [];

    for (const line of stack.split("\n")) {
      if (frames.length >= MAX_FRAMES) {
        break;
      }
      const match = FRAME_RE.exec(line);
      if (!match) {
        continue; // the "Error: message" header line, or anything unparseable
      }

      const [, , fn, file, lineNo] = match;
      const frame: BacktraceFrame = {
        file: file ?? null,
        line: lineNo !== undefined ? Number(lineNo) : null,
        method: fn ?? null,
        in_app: this.isInApp(file),
      };
      this.attachSourceContext(frame);
      frames.push(frame);
    }

    return frames;
  }

  /**
   * Would attach `context_line`/`pre_context`/`post_context` to `frame` (5 lines of source either
   * side of the culprit line, individual lines truncated past 500 characters: see
   * Configuration.captureSourceContext's own doc comment, and
   * gems/forge_ops_tracker/lib/forge_ops_tracker/event_builder.rb's CONTEXT_LINES/
   * MAX_CONTEXT_LINE_LENGTH for the shared design this mirrors) the same way every ForgeOps SDK
   * with a real on-device source tree does: gated on `configuration.captureSourceContext` being
   * on, the frame being in-app, and a real, openable file path actually being available.
   *
   * **This is a deliberate, documented no-op on React Native, always.** Two separate facts rule
   * out a real implementation here, not just make it inconvenient:
   *
   * - This client's JS runtime is Hermes (or JSC in some configurations), never Node: there is
   *   no `fs` module, or any other filesystem API, available to a React Native app's JS bundle at
   *   all, in development or in a release build, without adding a native module this package
   *   doesn't depend on (see README.md's "Dependencies": zero third-party packages).
   * - Even if one were added, `frame.file` here is never a real path on the device's own
   *   filesystem: a release build's frames point into one single bundled/minified JS file
   *   (`index.android.bundle`/`main.jsbundle`), and a development build's frames point at a Metro
   *   dev-server URL (e.g. `http://localhost:8081/index.bundle?platform=ios&dev=true`), not a
   *   path `fs.readFileSync` (or equivalent) could open even with filesystem access. See this same
   *   caveat on `isInApp` above and README.md's own "in_app backtrace frames" section.
   *
   * `frame` is accepted, and this call site wired into `backtrace()` above, only so this
   * function's shape mirrors every other SDK's real implementation, keeping
   * `Configuration.captureSourceContext` meaningful as a piece of API surface even though this
   * platform can never act on it.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see this function's own comment
  private attachSourceContext(frame: BacktraceFrame): void {
    // No-op: see this function's own doc comment above.
  }

  /**
   * A React Native release bundle is typically one single minified file (`index.android.bundle`/
   * `main.jsbundle`) covering the whole app plus every dependency: there's no meaningful
   * filesystem "app root" to compare against the way sdks/node's own Configuration#appRoot check
   * works, since app code and library code live in the exact same file. This only ever marks a
   * frame `in_app` when `Configuration.inAppHeuristicEnabled` is explicitly turned on (default
   * off) and the frame's path doesn't mention `node_modules`: most useful in a development
   * build (Metro's dev server keeps real, unminified per-file paths), honestly unreliable in a
   * real release build, which is why it isn't on by default.
   */
  private isInApp(file: string | undefined): boolean {
    if (!this.configuration.inAppHeuristicEnabled || !file) {
      return false;
    }
    return !file.includes("/node_modules/");
  }
}
