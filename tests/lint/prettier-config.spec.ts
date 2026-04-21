import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("Prettier configuration (task 1.2)", () => {
  it("resolves a config from the repo root", async () => {
    const cfg = await resolveConfig(resolve(root, "src/example.ts"));
    expect(cfg).not.toBeNull();
  });

  it("reformats unformatted TypeScript per the resolved config", async () => {
    const cfg = await resolveConfig(resolve(root, "src/example.ts"));
    const out = await format("const x ={a:1,b :2}\n", {
      ...(cfg ?? {}),
      filepath: "example.ts",
    });
    expect(out).not.toBe("const x ={a:1,b :2}\n");
    expect(out.trim().endsWith(";")).toBe(true);
  });

  it("ignores node_modules, dist, and coverage via .prettierignore", () => {
    const ignoreFile = readFileSync(resolve(root, ".prettierignore"), "utf8");
    for (const path of ["node_modules", "dist", "coverage"]) {
      expect(ignoreFile).toMatch(new RegExp(`(^|\\n)${path}(\\/|$)`));
    }
  });
});
