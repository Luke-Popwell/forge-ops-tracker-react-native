import { Configuration } from "./configuration.js";

export interface XhrCompletion {
  method: string;
  url: string;
  status: number;
  durationMs: number;
}

/**
 * What a listener's `beforeSend` sees of a request about to go out: enough to decide whether to add
 * a header, and to add it. Header names are compared case-insensitively, as HTTP does.
 */
export interface XhrOutgoing {
  method: string;
  url: string;
  /** A header the app set on this request with setRequestHeader(), or undefined if it set none. */
  header(name: string): string | undefined;
  setHeader(name: string, value: string): void;
}

/**
 * Called just before a request (never one of this client's own) is sent. Whatever it returns is
 * handed back to the same listener with that request's completion, so a listener can carry
 * per-request state (tracing's span id) from send to loadend without a map of its own.
 */
export type XhrBeforeSend = (request: XhrOutgoing) => unknown;

type XhrListener = (completion: XhrCompletion, state?: unknown) => void;

interface XhrMeta {
  method: string;
  url: string;
  startedAt: number;
  headers: Map<string, string>;
  states: Map<XhrListener, unknown>;
}

// One patch of XMLHttpRequest shared by every automatic source that needs to see network
// requests (breadcrumbs.ts, performanceFlusher.ts, tracing.ts), not one patch each: wrapping open()/send()
// twice would work, but every additional layer is another place a request can be double-counted or
// a restore can put back the wrong function. The patch is installed when the first listener
// arrives and removed again when the last one leaves.
//
// Wraps XMLHttpRequest only, not fetch as well: React Native's global fetch is the whatwg-fetch
// polyfill, built on `new XMLHttpRequest()` (confirmed directly against the react-native 0.87
// source this package's own devDependencies install: Libraries/Network/fetch.js requires
// whatwg-fetch, and that package's fetch.js constructs an XMLHttpRequest for every call), so this
// already sees every fetch, axios call, and hand-written XHR alike, and wrapping fetch too would
// report each fetch twice.
const listeners = new Map<XhrListener, { configuration: Configuration; beforeSend: XhrBeforeSend | undefined }>();
let originalOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalSend: typeof XMLHttpRequest.prototype.send | null = null;
let originalSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader | null = null;

// A WeakMap, not a property stashed on the XMLHttpRequest instance: avoids adding a visible field
// to an object the host app's own code also holds, and lets the entry be garbage-collected with
// the request itself.
const requestMeta = new WeakMap<XMLHttpRequest, XhrMeta>();

/**
 * True for a request to this client's own ForgeOps endpoints (events, performance_samples, ...):
 * the DSN's ingestion URL with its trailing "events" dropped, so every sibling endpoint under the
 * same directory counts. Deliberately excluded from every automatic source: otherwise each
 * reported error, and each performance flush, would itself leave a breadcrumb and a tally behind,
 * and a spike in errors would start drowning the very trail meant to explain them.
 */
export function isOwnRequest(configuration: Configuration, url: string): boolean {
  const ingestionUri = configuration.ingestionUri();
  if (ingestionUri === null) {
    return false;
  }
  const base = ingestionUri.endsWith("/events") ? ingestionUri.slice(0, -"events".length) : ingestionUri;
  return url.startsWith(base);
}

/**
 * Registers `listener` to be told about every completed request that isn't this client's own, and
 * `beforeSend` (if given) about each one just before it goes out. Returns a function that
 * unregisters both.
 */
export function addXhrListener(configuration: Configuration, listener: XhrListener, beforeSend?: XhrBeforeSend): () => void {
  listeners.set(listener, { configuration, beforeSend });
  patch();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unpatch();
    }
  };
}

function patch(): void {
  // Not present under a plain Node/test environment; nothing to wrap, nothing to fail loudly about.
  if (originalOpen !== null || typeof XMLHttpRequest === "undefined") {
    return;
  }

  const capturedOpen = XMLHttpRequest.prototype.open;
  originalOpen = capturedOpen;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    requestMeta.set(this, { method: method.toUpperCase(), url: url.toString(), startedAt: 0, headers: new Map(), states: new Map() });
    // async ?? true: XMLHttpRequest.open()'s own spec default when the caller omits async
    // entirely, always passed through explicitly here since TS resolves a .call() against the
    // overload requiring it, not the shorter two-arg one.
    capturedOpen.call(this, method, url, async ?? true, username, password);
  };

  // Wrapped only to remember which headers the app set: XMLHttpRequest has no way to read a request
  // header back, and a beforeSend must be able to leave one the app chose alone (a traceparent it
  // set itself). Absent on some test doubles, in which case there is nothing to wrap.
  const capturedSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader as typeof XMLHttpRequest.prototype.setRequestHeader | undefined;
  if (typeof capturedSetRequestHeader === "function") {
    originalSetRequestHeader = capturedSetRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
      requestMeta.get(this)?.headers.set(name.toLowerCase(), value);
      capturedSetRequestHeader.call(this, name, value);
    };
  }

  const capturedSend = XMLHttpRequest.prototype.send;
  originalSend = capturedSend;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
    const meta = requestMeta.get(this);
    if (meta) {
      runBeforeSend(this, meta);
      meta.startedAt = Date.now();
      this.addEventListener("loadend", () => {
        const completion: XhrCompletion = {
          method: meta.method,
          url: meta.url,
          status: this.status,
          durationMs: Date.now() - meta.startedAt,
        };
        for (const [listener, { configuration }] of [...listeners]) {
          if (!isOwnRequest(configuration, meta.url)) {
            listener(completion, meta.states.get(listener));
          }
        }
      });
    }
    capturedSend.call(this, body);
  };
}

function runBeforeSend(request: XMLHttpRequest, meta: XhrMeta): void {
  for (const [listener, { configuration, beforeSend }] of [...listeners]) {
    if (!beforeSend || isOwnRequest(configuration, meta.url)) {
      continue;
    }
    const outgoing: XhrOutgoing = {
      method: meta.method,
      url: meta.url,
      header: (name) => meta.headers.get(name.toLowerCase()),
      setHeader: (name, value) => {
        const setRequestHeader = originalSetRequestHeader ?? (request as { setRequestHeader?: (n: string, v: string) => void }).setRequestHeader;
        setRequestHeader?.call(request, name, value);
        meta.headers.set(name.toLowerCase(), value);
      },
    };
    // Never lets a listener's failure stop the app's own request from going out.
    try {
      meta.states.set(listener, beforeSend(outgoing));
    } catch (e) {
      const err = e as Error;
      configuration.log(`[forge-ops-tracker] request instrumentation failed: ${err.name}: ${err.message}`);
    }
  }
}

function unpatch(): void {
  // The global can be gone by now (a test environment that tore it down first): nothing left to
  // restore onto, but the module's own state still has to be reset so a later patch() starts clean.
  if (originalOpen) {
    if (typeof XMLHttpRequest !== "undefined") {
      XMLHttpRequest.prototype.open = originalOpen;
    }
    originalOpen = null;
  }
  if (originalSend) {
    if (typeof XMLHttpRequest !== "undefined") {
      XMLHttpRequest.prototype.send = originalSend;
    }
    originalSend = null;
  }
  if (originalSetRequestHeader) {
    if (typeof XMLHttpRequest !== "undefined") {
      XMLHttpRequest.prototype.setRequestHeader = originalSetRequestHeader;
    }
    originalSetRequestHeader = null;
  }
}
