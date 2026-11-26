import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["tests/unit/**/*.test.ts"],
    exclude: [
      "node_modules/**",
      "tests/e2e/**",
      ".next/**",
      ".agents/**",
      ".gemini/**",
      ".cache/**",
      ".config/**",
      ".local/**",
      ".npm/**",
    ],
  },
});
