import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
  globalIgnores([
    // Next.js & build artifacts
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Runtime data & test reports
    "data/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    // Home directory ($HOME == workspace) dotdirs
    ".*/**",
    ".agents/**",
    ".android/**",
    ".cache/**",
    ".config/**",
    ".gemini/**",
    ".gradle/**",
    ".local/**",
    ".npm/**",
    ".vercel/**",
  ]),
]);

export default eslintConfig;
