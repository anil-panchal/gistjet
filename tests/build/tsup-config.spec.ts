import type { Options } from "tsup";
import { describe, expect, it } from "vitest";

import tsupConfig from "../../tsup.config";

const raw = tsupConfig as Options | Options[];
const cfg: Options = Array.isArray(raw) ? raw[0]! : raw;

describe("tsup build configuration (task 1.4)", () => {
  it("includes the src/bin/gistjet.ts entry", () => {
    const entry = cfg.entry;
    const values: string[] = Array.isArray(entry)
      ? (entry as string[])
      : entry
        ? (Object.values(entry as Record<string, string>) as string[])
        : [];
    expect(values.some((e) => e.includes("src/bin/gistjet.ts"))).toBe(true);
  });

  it("produces an ESM bundle", () => {
    const format = cfg.format;
    const formats = Array.isArray(format) ? format : format ? [format] : [];
    expect(formats).toContain("esm");
  });

  it("targets Node 20 or newer", () => {
    const target = Array.isArray(cfg.target) ? cfg.target.join(",") : (cfg.target ?? "");
    expect(String(target)).toMatch(/node(2[0-9]|[3-9]\d)/);
  });

  it("prefixes the bundle with a node shebang via banner.js", () => {
    const banner = cfg.banner;
    const js = typeof banner === "object" && banner !== null ? (banner.js ?? "") : "";
    expect(String(js)).toContain("#!/usr/bin/env node");
  });

  it("emits into the dist/ directory", () => {
    expect(cfg.outDir).toBe("dist");
  });
});
