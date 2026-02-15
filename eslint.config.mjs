import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Project-specific ignores (helper scripts are not deployed)
    "scripts/**",
    "outputs/**",
  ]),
  {
    files: ["src/app/api/**/*.{ts,tsx}", "middleware.ts"],
    rules: {
      // API routes often deal with dynamic payloads; strict any-ban is too noisy here.
      "@typescript-eslint/no-explicit-any": "off",
      // Some integrations still use require() in server routes.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
