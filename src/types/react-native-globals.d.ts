// Minimal ambient declarations for the two React Native globals this package touches directly.
// Not a dependency on @types/react-native (a much larger surface this package doesn't need):
// just the two names actually used, kept local and small.

/**
 * React Native's own global error-handling object, set up by the RN runtime itself before any
 * app code runs. `getGlobalHandler`/`setGlobalHandler` are RN's documented public API for
 * exactly this purpose (see React Native's own `Libraries/Core/ErrorUtils.js`): the RN
 * equivalent of `window.onerror`, for an environment with no `window` at all.
 */
declare const ErrorUtils: {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
};

/** True in a React Native development build, false in a release build: set globally by the RN
 * bundler (Metro), the same role `NODE_ENV` plays in a plain Node app. */
declare const __DEV__: boolean;

/**
 * The module React Native's own internal Promise setup uses for unhandled-rejection tracking:
 * ships wherever `react-native` itself is installed (a transitive dependency, via the `promise`
 * package), but has no type declarations of its own. Only the one function this package actually
 * calls is typed here, not the module's full surface.
 */
declare module "promise/setimmediate/rejection-tracking" {
  export function enable(options: {
    allRejections?: boolean;
    onUnhandled?: (id: number, error: unknown) => void;
    onHandled?: (id: number) => void;
  }): void;
  export function disable(): void;
}
