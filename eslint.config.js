import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import importPlugin from "eslint-plugin-import";

const coreForbiddenImports = [
  {
    group: ["@modelcontextprotocol", "@modelcontextprotocol/*"],
    message:
      "core must not import the MCP SDK — access it through a port implemented in the façade or an adapter.",
  },
  {
    group: ["@octokit", "@octokit/*"],
    message: "core must not import Octokit — access GitHub through the GitHubGistPort adapter.",
  },
  {
    group: ["pino", "pino/*"],
    message: "core must not import pino — use the Logger port.",
  },
  {
    group: [
      "**/adapters",
      "**/adapters/*",
      "**/adapters/**",
      "../adapters",
      "../adapters/*",
      "../../adapters",
      "../../adapters/*",
    ],
    message: "core must not reach into adapters — depend on ports defined in src/shared.",
  },
  {
    group: [
      "**/facade",
      "**/facade/*",
      "**/facade/**",
      "../facade",
      "../facade/*",
      "../../facade",
      "../../facade/*",
    ],
    message: "core must not import the façade layer.",
  },
  {
    group: [
      "**/bootstrap",
      "**/bootstrap/*",
      "**/bootstrap/**",
      "../bootstrap",
      "../bootstrap/*",
      "../../bootstrap",
      "../../bootstrap/*",
    ],
    message: "core must not import the composition root.",
  },
];

const facadeForbiddenImports = [
  {
    group: ["@octokit", "@octokit/*"],
    message:
      "façade must not import Octokit directly — route GitHub access through core services and ports.",
  },
  {
    group: [
      "**/adapters",
      "**/adapters/*",
      "**/adapters/**",
      "../adapters",
      "../adapters/*",
      "../../adapters",
      "../../adapters/*",
    ],
    message: "façade must not reach into adapters — depend on core services only.",
  },
];

export default [
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**", ".husky/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
    },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: coreForbiddenImports }],
    },
  },
  {
    files: ["src/facade/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: facadeForbiddenImports }],
    },
  },
];
