import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  "lint-staged"?: Record<string, string | string[]>;
};

describe("Pre-commit wiring (task 1.2)", () => {
  it("declares husky and lint-staged as dev deps", () => {
    expect(pkg.devDependencies?.husky).toBeDefined();
    expect(pkg.devDependencies?.["lint-staged"]).toBeDefined();
  });

  it("wires a non-fatal prepare script for husky", () => {
    const prepare = pkg.scripts?.prepare ?? "";
    expect(prepare).toMatch(/husky/);
  });

  it("configures lint-staged for ts and format targets", () => {
    const config = pkg["lint-staged"];
    expect(config, "missing lint-staged config").toBeDefined();
    const keys = Object.keys(config ?? {});
    expect(keys.some((k) => k.includes("ts"))).toBe(true);
    const commands = Object.values(config ?? {})
      .flat()
      .join(" ");
    expect(commands).toMatch(/prettier/);
    expect(commands).toMatch(/eslint/);
  });

  it(".husky/pre-commit exists and invokes lint-staged", () => {
    const hook = readFileSync(resolve(root, ".husky/pre-commit"), "utf8");
    expect(hook).toMatch(/lint-staged/);
  });
});
