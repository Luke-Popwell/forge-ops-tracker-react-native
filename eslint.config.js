import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        // React Native's own global environment: no window/document (there's no DOM), but
        // fetch/AbortController/setTimeout are all provided by RN's own polyfills, and ErrorUtils
        // is RN's own global object (see src/types/react-native-globals.d.ts for its type).
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        ErrorUtils: "readonly",
        __DEV__: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);
