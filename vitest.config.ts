import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Mirror tsconfig's "@/*" paths so tests can import app modules directly.
    alias: { "@": root },
  },
});
