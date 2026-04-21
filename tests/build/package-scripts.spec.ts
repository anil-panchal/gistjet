import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

describe("package scripts for build (task 1.4)", () => {
  it("exposes a build script that invokes tsup", () => {
    const build = pkg.scripts?.build ?? "";
    expect(build).toMatch(/tsup/);
  });

  it("prepublishOnly runs lint, typecheck, test, and build", () => {
    const script = pkg.scripts?.prepublishOnly ?? "";
    expect(script, "prepublishOnly script missing").not.toBe("");
    expect(script).toMatch(/lint/);
    expect(script).toMatch(/typecheck/);
    expect(script).toMatch(/test/);
    expect(script).toMatch(/build/);
  });
});
