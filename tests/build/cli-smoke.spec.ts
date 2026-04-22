import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const binaryPath = resolve(root, "dist/bin/gistjet.js");
const tsupBin = resolve(root, "node_modules/tsup/dist/cli-default.js");

describe("CLI smoke tests (task 5)", () => {
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

  it("--version outputs semver and exits 0", () => {
    const result = spawnSync(process.execPath, [binaryPath, "--version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("-v outputs the same as --version", () => {
    const longResult = spawnSync(process.execPath, [binaryPath, "--version"], {
      encoding: "utf8",
    });
    const shortResult = spawnSync(process.execPath, [binaryPath, "-v"], {
      encoding: "utf8",
    });
    expect(shortResult.status).toBe(0);
    expect(shortResult.stdout).toBe(longResult.stdout);
  });

  it("--help outputs GISTJET_GITHUB_TOKEN and exits 0", () => {
    const result = spawnSync(process.execPath, [binaryPath, "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GISTJET_GITHUB_TOKEN");
  });
});
