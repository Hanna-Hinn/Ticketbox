import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

// Non-type-checked TypeScript rules for now (no `projectService`). Type-aware
// linting needs a settled multi-tsconfig project layout; with domain/,
// application/, and infrastructure/ still empty (Stage 1+), there's nothing
// yet for the extra rigor to protect. Worth revisiting once there's real
// business logic to check — TB-009 already touches this file for the layer
// boundary rules, so that's a natural point to reconsider.
export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/.husky/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  eslintConfigPrettier,
);
