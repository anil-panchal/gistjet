import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundlePath = resolve(root, "dist/bin/gistjet.js");
const tsupBin = resolve(root, "node_modules/tsup/dist/cli-default.js");

describe("tsup build smoke (task 1.4)", () => {
  beforeAll(() => {
    const result = spawnSync(process.execPath, [tsupBin], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    if (result.status !== 0) {
      throw new Error(
        `tsup build failed (status=${result.status}):\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
      );
    }
  }, 120_000);

  it("produces dist/bin/gistjet.js", () => {
    expect(statSync(bundlePath).isFile()).toBe(true);
  });

  it("prefixes the bundle with a node shebang", () => {
    const content = readFileSync(bundlePath, "utf8");
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });
});
