import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["workspace"],
  },
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
