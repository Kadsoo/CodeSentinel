import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "tests/**/*.test.ts"
    ],
    // Keep integration suites reproducible on shared CI runners. The API
    // tests are fast in isolation but can exceed Vitest's default 5s timeout
    // while many workers import native SQLite bindings concurrently.
    testTimeout: 15_000,
    hookTimeout: 15_000,
    maxWorkers: 4,
  }
});
