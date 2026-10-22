import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // "node", not "jsdom": React Native has no DOM at all: fetch/AbortController/ErrorUtils are
    // all mocked directly in each test file instead (see test/setup pattern in each test),
    // mirroring how a real RN app's own Jest test environment (no browser, no DOM) works.
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
