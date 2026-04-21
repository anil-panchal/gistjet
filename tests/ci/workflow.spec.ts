import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

describe("GitHub Actions CI workflow (task 1.5)", () => {
  it("triggers on push and pull_request", () => {
    expect(workflow).toMatch(/(^|\n)on:/);
    expect(workflow).toMatch(/\bpush:/);
    expect(workflow).toMatch(/\bpull_request:/);
  });

  it.each(["ubuntu-latest", "macos-latest", "windows-latest"])(
    "includes %s in the OS matrix",
    (os) => {
      expect(workflow).toContain(os);
    },
  );

  it.each([20, 22])("includes Node %d in the matrix", (version) => {
    const re = new RegExp(
      `node-version:[\\s\\S]*?(?:\\[[^\\]]*?\\b${version}\\b|-\\s*${version}\\b)`,
    );
    expect(workflow).toMatch(re);
  });

  it("disables fail-fast so every matrix cell reports", () => {
    expect(workflow).toMatch(/fail-fast:\s*false/);
  });

  it.each([
    ["lint", /npm run lint\b/],
    ["typecheck", /npm run typecheck\b/],
    ["test", /npm (run )?test\b/],
    ["build", /npm run build\b/],
  ])("runs the %s step", (_name, pattern) => {
    expect(workflow).toMatch(pattern);
  });

  it("uses actions/checkout", () => {
    expect(workflow).toMatch(/uses:\s*actions\/checkout@v\d/);
  });

  it("uses actions/setup-node with the npm cache", () => {
    expect(workflow).toMatch(/uses:\s*actions\/setup-node@v\d/);
    expect(workflow).toMatch(/cache:\s*["']?npm["']?/);
  });

  it("templates node-version from the matrix", () => {
    expect(workflow).toMatch(/node-version:\s*\$\{\{\s*matrix\.node-version/);
  });

  it("installs via npm ci for reproducibility", () => {
    expect(workflow).toMatch(/npm ci\b/);
  });
});
