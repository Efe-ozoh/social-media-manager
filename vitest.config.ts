import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" paths so tests can import app modules directly.
    alias: { "@": root },
  },
  test: {
    // The renderer tests run Satori, resvg and sharp over real images; the
    // default 5 seconds is too tight on a cold or slower machine.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
