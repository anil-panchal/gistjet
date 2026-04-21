import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  type?: string;
  engines?: { node?: string };
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const tsconfig = JSON.parse(readFileSync(resolve(root, "tsconfig.json"), "utf8")) as {
  compilerOptions?: Record<string, unknown>;
};

const semverAtLeast = (range: string | undefined, major: number, minor: number): boolean => {
  if (!range) return false;
  const match = /^\^?(\d+)\.(\d+)/.exec(range.trim());
  if (!match) return false;
  const maj = Number(match[1]);
  const min = Number(match[2]);
  return maj === major && min >= minor;
};

describe("package.json baseline (task 1.1)", () => {
  it("declares ESM module type", () => {
    expect(pkg.type).toBe("module");
  });

  it("requires Node >= 20 in engines", () => {
    expect(pkg.engines?.node).toMatch(/>=\s*20/);
  });

  it("publishes a bin entry pointing at dist/bin/gistjet.js", () => {
    expect(pkg.bin).toBeDefined();
    const entries: Record<string, string> =
      typeof pkg.bin === "string" ? { gistjet: pkg.bin } : (pkg.bin ?? {});
    const values = Object.values(entries);
    expect(values.length).toBeGreaterThan(0);
    expect(values).toContainEqual(expect.stringMatching(/dist\/bin\/gistjet\.js$/));
  });

  const prodPins: Array<[string, number, number]> = [
    ["@modelcontextprotocol/sdk", 1, 29],
    ["@octokit/rest", 22, 0],
    ["zod", 3, 23],
    ["pino", 9, 0],
    ["diff", 5, 0],
    ["ignore", 5, 0],
    ["ulid", 2, 0],
  ];
  it.each(prodPins)("pins prod dep %s at ^%d.%d+", (name, major, minor) => {
    const range = pkg.dependencies?.[name];
    expect(range, `missing prod dep ${name}`).toBeDefined();
    expect(
      semverAtLeast(range, major, minor),
      `expected ${name} range >= ^${major}.${minor}, got ${range}`,
    ).toBe(true);
  });

  it("declares @octokit/plugin-throttling as a prod dep", () => {
    expect(pkg.dependencies?.["@octokit/plugin-throttling"]).toBeDefined();
  });

  const devDeps = [
    "vitest",
    "@vitest/coverage-v8",
    "msw",
    "fast-check",
    "tsup",
    "eslint",
    "@typescript-eslint/parser",
    "@typescript-eslint/eslint-plugin",
    "eslint-plugin-import",
    "prettier",
    "typescript",
  ];
  it.each(devDeps)("declares dev dep %s", (name) => {
    expect(pkg.devDependencies?.[name], `missing dev dep ${name}`).toBeDefined();
  });
});

describe("tsconfig.json baseline (task 1.1)", () => {
  const opts = tsconfig.compilerOptions ?? {};

  it("enables strict", () => {
    expect(opts.strict).toBe(true);
  });

  it("enables noImplicitAny", () => {
    expect(opts.noImplicitAny).toBe(true);
  });

  it("enables exactOptionalPropertyTypes", () => {
    expect(opts.exactOptionalPropertyTypes).toBe(true);
  });

  it("enables noUncheckedIndexedAccess", () => {
    expect(opts.noUncheckedIndexedAccess).toBe(true);
  });

  it("uses moduleResolution=bundler", () => {
    expect(opts.moduleResolution).toBe("bundler");
  });
});
