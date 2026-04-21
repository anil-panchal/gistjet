import { describe, expect, it } from "vitest";

import config from "../../vitest.config";

type Thresholds = Record<string, unknown> & {
  lines?: number;
  functions?: number;
  branches?: number;
  statements?: number;
};

const test = config.test ?? {};
const coverage = (test.coverage ?? {}) as { provider?: string; thresholds?: Thresholds };

describe("vitest configuration (task 1.3)", () => {
  it("uses the Node test environment", () => {
    expect(test.environment).toBe("node");
  });

  it("wires the shared setup file at tests/setup.ts", () => {
    const raw = test.setupFiles;
    const setupFiles = Array.isArray(raw) ? raw : raw ? [raw] : [];
    expect(setupFiles.some((p) => typeof p === "string" && p.includes("tests/setup.ts"))).toBe(
      true,
    );
  });
});

describe("vitest coverage configuration (task 1.3)", () => {
  it("uses the v8 coverage provider", () => {
    expect(coverage.provider).toBe("v8");
  });

  it("enforces ≥85% global thresholds on lines/functions/branches/statements", () => {
    const t = coverage.thresholds ?? {};
    expect(t.lines, "lines threshold").toBeGreaterThanOrEqual(85);
    expect(t.functions, "functions threshold").toBeGreaterThanOrEqual(85);
    expect(t.branches, "branches threshold").toBeGreaterThanOrEqual(85);
    expect(t.statements, "statements threshold").toBeGreaterThanOrEqual(85);
  });

  const highRiskModules = ["secret-scanner", "redactor", "sync-service", "local-overwrite-gate"];

  it.each(highRiskModules)("enforces ≥95%% per-module thresholds for %s", (name) => {
    const t = coverage.thresholds ?? {};
    const entry = Object.entries(t).find(
      ([key]) => typeof key === "string" && key.toLowerCase().includes(name),
    );
    expect(entry, `missing per-module threshold for ${name}`).toBeDefined();
    const rules = entry![1] as Thresholds;
    expect(rules.lines, `${name}.lines`).toBeGreaterThanOrEqual(95);
    expect(rules.functions, `${name}.functions`).toBeGreaterThanOrEqual(95);
    expect(rules.branches, `${name}.branches`).toBeGreaterThanOrEqual(95);
    expect(rules.statements, `${name}.statements`).toBeGreaterThanOrEqual(95);
  });
});
