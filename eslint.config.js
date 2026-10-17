import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

// Non-type-checked TypeScript rules for now (no `projectService`). Type-aware
// linting needs a settled multi-tsconfig project layout; with domain/,
// application/, and infrastructure/ still empty (Stage 1+), there's nothing
// yet for the extra rigor to protect. Worth revisiting once there's real
// business logic to check — TB-009 already touches this file for the layer
// boundary rules, so that's a natural point to reconsider.
//
// TB-009 reconsidered it and left it: type-aware rules do not enforce import
// boundaries, which is the only thing that task is about.

// The Dependency Rule (handbook §2.3), as lint. Specifiers are matched as
// strings, so relative imports are judged by their text: there are no path
// aliases and no barrels in this repo, and this is one reason to keep it so.
const api = "packages/api/src";

function forbid(files, patterns, ignores = []) {
  return {
    files,
    ignores,
    rules: {
      "no-restricted-imports": ["error", { patterns }],
    },
  };
}

const layerBoundaries = [
  // L1 imports nothing. Every domain file sits at domain/<kind>/File.ts, so
  // "./" and "../" stay inside domain/ and "../../" is the way out.
  forbid(
    [`${api}/domain/**/*.ts`],
    [
      {
        regex: "^(?!\\.\\.?/)",
        message: "domain/ imports nothing outside domain/ — not a package, not a builtin.",
      },
      {
        regex: "^\\.\\./\\.\\./",
        message: "domain/ imports nothing outside domain/.",
      },
    ],
  ),
  // L2 imports L1 and L2 only. Never a driver, never an outer layer.
  forbid(
    [`${api}/application/**/*.ts`],
    [
      {
        group: ["ioredis", "ioredis/*", "pg", "pg/*", "fastify", "fastify/*"],
        message: "application/ never imports a driver. Define a port instead.",
      },
      {
        group: ["**/infrastructure/**", "**/presentation/**", "**/main/**", "**/worker/**"],
        message: "application/ imports domain/ and application/ only.",
      },
    ],
  ),
  // The two L3 halves import inward and never each other.
  forbid(
    [`${api}/infrastructure/**/*.ts`],
    [
      {
        group: ["**/presentation/**", "**/main/**", "**/worker/**"],
        message: "infrastructure/ imports inward only — never presentation/ or main/.",
      },
    ],
  ),
  forbid(
    [`${api}/presentation/**/*.ts`],
    [
      {
        group: ["**/infrastructure/**", "**/main/**", "**/worker/**"],
        message: "presentation/ imports inward only — never infrastructure/ or main/.",
      },
    ],
  ),
  // Only the composition root wires concrete adapters. migrate.ts and seed.ts
  // (TB-004) are CLI entry points that are each their own one-adapter root.
  forbid(
    [`${api}/main/**/*.ts`, `${api}/worker/**/*.ts`],
    [
      {
        group: ["**/infrastructure/**", "**/presentation/**"],
        message: "Only main/composition.ts may import a concrete adapter.",
      },
    ],
    [`${api}/main/composition.ts`, `${api}/main/migrate.ts`, `${api}/main/seed.ts`],
  ),
];

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**"] },
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
  ...layerBoundaries,
  eslintConfigPrettier,
);
