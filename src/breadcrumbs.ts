import { Configuration } from "./configuration.js";
import { addXhrListener } from "./xhrInstrumentation.js";

export type BreadcrumbLevel = "debug" | "info" | "warning" | "error";

export interface Breadcrumb {
  category: string;
  message: string;
  level: BreadcrumbLevel;
  timestamp: string;
  data?: Record<string, unknown>;
}

// A single console.log(hugeObject) or a very long URL shouldn't make one breadcrumb dominate an
// event's payload size, the same bound sdks/typescript's own breadcrumbs.ts applies.
const MAX_MESSAGE_LENGTH = 500;

/**
 * A bounded, in-order trail of whatever happened recently in the app: console output and network
 * requests, captured automatically once installBreadcrumbs() runs below, plus anything added by
 * hand via addBreadcrumb() in index.ts. A ring buffer, not an unbounded log: the oldest entry is
 * dropped once Configuration#maxBreadcrumbs is reached. Deliberately never cleared after a report:
 * the trail leading up to one error is still exactly what's relevant if another is reported moments
 * later. One shared trail for the whole app, not per anything: a mobile app is effectively
 * single-flow, and React Native's JS runs on one thread, so there is nothing to lock or scope.
 * Ported from sdks/typescript/src/breadcrumbs.ts.
 */
export class BreadcrumbBuffer {
  private configuration: Configuration;
  private entries: Breadcrumb[] = [];

  constructor(configuration: Configuration) {
    this.configuration = configuration;
  }

  add(breadcrumb: Breadcrumb): void {
    // Read fresh on every add, not captured once at construction: a size change from init() has
    // to take effect on whatever's added next.
    // Strict privacy: breadcrumbs are free text, never sent then, so they aren't kept either.
    const maxSize = Math.max(0, this.configuration.maxBreadcrumbs);
    if (maxSize === 0 || this.configuration.strictPrivacy) {
      return;
    }

    this.entries.push(breadcrumb);
    while (this.entries.length > maxSize) {
      this.entries.shift();
    }
  }

  all(): Breadcrumb[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

let installed = false;
const originalConsoleMethods: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
let removeXhrListener: (() => void) | null = null;

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_LEVELS: Record<ConsoleMethod, BreadcrumbLevel> = {
  log: "info",
  info: "info",
  warn: "warning",
  error: "error",
  debug: "debug",
};

/**
 * Installs the automatic breadcrumb sources that exist in React Native: console output and
 * network requests. Idempotent. Each source wraps whatever's currently installed rather than
 * assuming it's still the untouched original, so this composes with anything else (React Native's
 * own dev tooling, another SDK) that has already patched the same global.
 *
 * sdks/typescript's navigation and click sources have no equivalent here: there is no `window`,
 * `history`, or DOM in React Native, and navigation is whatever library the host app chose
 * (React Navigation, Expo Router, ...), which this package can't hook generically. Record a
 * screen change with addBreadcrumb() from that library's own navigation callback instead.
 *
 * Network requests are captured by wrapping XMLHttpRequest only, not fetch as well, unlike
 * sdks/typescript: React Native's global fetch is the whatwg-fetch polyfill, which is built on
 * `new XMLHttpRequest()` (confirmed directly against the react-native 0.87 source this package's
 * own devDependencies install: Libraries/Network/fetch.js requires whatwg-fetch, and that
 * package's fetch.js constructs an XMLHttpRequest for every call), so wrapping XHR already sees
 * every fetch, axios call, and hand-written XHR alike, and wrapping fetch too would record each
 * fetch twice.
 */
export function installBreadcrumbs(configuration: Configuration, buffer: BreadcrumbBuffer): void {
  if (installed) {
    return;
  }
  installed = true;

  installConsoleBreadcrumbs(buffer);
  installNetworkBreadcrumbs(configuration, buffer);
}

/** @internal not part of the public API: restores every patched global between test cases */
export function uninstallBreadcrumbs(): void {
  if (!installed) {
    return;
  }
  installed = false;

  for (const method of Object.keys(originalConsoleMethods) as ConsoleMethod[]) {
    const original = originalConsoleMethods[method];
    if (original) {
      console[method] = original;
    }
    delete originalConsoleMethods[method];
  }

  removeXhrListener?.();
  removeXhrListener = null;
}

function installConsoleBreadcrumbs(buffer: BreadcrumbBuffer): void {
  for (const method of Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]) {
    // The exact, unbound reference currently on console[method]: stored as-is (not .bind()'d,
    // which would produce a new function object) so uninstallBreadcrumbs() restores the identical
    // reference it overwrote, not just an equivalent one.
    const original = console[method];
    originalConsoleMethods[method] = original;

    console[method] = (...args: unknown[]): void => {
      buffer.add({
        category: "console",
        message: truncate(args.map(stringifyArg).join(" ")),
        level: CONSOLE_LEVELS[method],
        timestamp: new Date().toISOString(),
      });
      original.apply(console, args);
    };
  }
}

/**
 * Records each completed request (see xhrInstrumentation.ts for what "each" covers and why it is
 * XMLHttpRequest only, and for why this client's own delivery requests never appear here).
 */
function installNetworkBreadcrumbs(configuration: Configuration, buffer: BreadcrumbBuffer): void {
  removeXhrListener = addXhrListener(configuration, ({ method, url, status, durationMs }) => {
    buffer.add({
      category: "xhr",
      message: truncate(`${method} ${url}`),
      level: status >= 200 && status < 400 ? "info" : "warning",
      timestamp: new Date().toISOString(),
      data: { status, duration_ms: durationMs },
    });
  });
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }
  if (arg instanceof Error) {
    return arg.message;
  }
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}...` : message;
}
