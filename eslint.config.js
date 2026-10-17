import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

// Non-type-checked TypeScript rules (no `projectService`). Type-aware linting
// needs a settled multi-tsconfig project layout, and nothing here needs it:
// the layer boundaries below are about import specifiers, not types.

// The Dependency Rule as lint — handbook "Boundaries (enforced, not
// aspirational)" and the CLAUDE.md layer table. Specifiers are matched as
// strings, so relative imports are judged by their text: there are no path
// aliases and no barrels in this repo, and this is one reason to keep it so.
const api = "packages/api/src";

// A specifier that does not start with "./" or "../": a package or a builtin.
const anyPackageOrBuiltin = "^(?!\\.\\.?/)";

function forbid(files, patterns, { except = [] } = {}) {
  return {
    files,
    ignores: except,
    rules: {
      "no-restricted-imports": ["error", { patterns }],
    },
  };
}

const layerBoundaries = [
  // no-restricted-imports does not see dynamic import() or typeof import(),
  // so neither is allowed anywhere under src/. Wiring is static.
  {
    files: [`${api}/**/*.ts`],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message: "No dynamic import(): it bypasses the boundary lint.",
        },
        { selector: "TSImportType", message: "No typeof import(): it bypasses the boundary lint." },
      ],
    },
  },
  // L1 imports nothing. Domain files live at domain/<kind>/File.ts, so "./"
  // and "../" stay inside domain/ and "../../" is the way out; the named
  // layers are listed as well so a file at the wrong depth cannot slip past.
  forbid(
    [`${api}/domain/**/*.ts`],
    [
      {
        regex: anyPackageOrBuiltin,
        message: "domain/ imports nothing outside domain/ — not a package, not a builtin.",
      },
      {
        regex: "^\\.\\./\\.\\./",
        message: "domain/ files live at domain/<kind>/File.ts; ../../ leaves domain/.",
      },
      {
        group: [
          "**/application/**",
          "**/infrastructure/**",
          "**/presentation/**",
          "**/main/**",
          "**/worker/**",
          "**/test/**",
        ],
        message: "domain/ imports nothing outside domain/.",
      },
    ],
  ),
  // L2 imports L1 and L2 only. Not a driver, not a builtin, not a fake:
  // if a use case needs a clock or a uuid, that is a port.
  forbid(
    [`${api}/application/**/*.ts`],
    [
      {
        regex: anyPackageOrBuiltin,
        message:
          "application/ never imports a package or a builtin — not ioredis, pg, fastify, not node:crypto, not zod. Define a port instead.",
      },
      {
        group: [
          "**/infrastructure/**",
          "**/presentation/**",
          "**/main/**",
          "**/worker/**",
          "**/test/**",
        ],
        message: "application/ imports domain/ and application/ only.",
      },
    ],
  ),
  // The two L3 halves import inward and never each other.
  forbid(
    [`${api}/infrastructure/**/*.ts`],
    [
      {
        group: ["**/presentation/**", "**/main/**", "**/worker/**", "**/test/**"],
        message: "infrastructure/ imports inward only — never presentation/, main/ or test/.",
      },
    ],
  ),
  forbid(
    [`${api}/presentation/**/*.ts`],
    [
      {
        group: ["**/infrastructure/**", "**/main/**", "**/worker/**", "**/test/**"],
        message: "presentation/ imports inward only — never infrastructure/, main/ or test/.",
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
    { except: [`${api}/main/composition.ts`, `${api}/main/migrate.ts`, `${api}/main/seed.ts`] },
  ),
];

// packages/web takes DTO *types* from the API package and nothing else, and
// talks HTTP only through src/api/ (TB-015). Same bypass bans as the API.
const web = "packages/web/src";
const noImportBypass = [
  { selector: "ImportExpression", message: "No dynamic import(): it bypasses the boundary lint." },
  { selector: "TSImportType", message: "No typeof import(): it bypasses the boundary lint." },
];
const webBoundaries = [
  {
    files: [`${web}/**/*.ts`, `${web}/**/*.tsx`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^@ticketbox/api/(?!src/presentation/dto/)",
              message: "web imports DTO types from api (src/presentation/dto/) and nothing else.",
            },
            {
              regex: "^@ticketbox/api/src/presentation/dto/",
              allowTypeImports: true,
              message: "DTO types only — a value import would ship the Zod schema to the browser.",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...noImportBypass],
    },
  },
  {
    files: [`${web}/**/*.ts`, `${web}/**/*.tsx`],
    ignores: [`${web}/api/**`],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...noImportBypass,
        {
          selector: 'CallExpression[callee.name="fetch"]',
          message: "No raw fetch outside src/api/ — add a function to the client.",
        },
      ],
    },
  },
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
  ...webBoundaries,
  eslintConfigPrettier,
);
