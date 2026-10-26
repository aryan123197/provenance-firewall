import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // The fake PayPal is test scaffolding and main.ts only starts the server. The dashboard has its own component tests but is left out of the floor.
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/testing/**", "packages/dashboard/**", "packages/server/src/main.ts"],
      reporter: ["text-summary", "text"],
      // A floor, not a target: it fails `pnpm coverage` if a change leaves a lot of new code untested.
      thresholds: { lines: 95, statements: 92, functions: 95, branches: 82 },
    },
  },
});
