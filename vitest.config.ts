import { defineConfig } from "vitest/config";

const highRiskModuleThreshold = {
  lines: 95,
  functions: 95,
  branches: 95,
  statements: 95,
};

export default defineConfig({
  define: { __GISTJET_VERSION__: '"0.0.0-test"' },
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.spec.ts", "src/**/*.spec.ts"],
    exclude: ["node_modules/**", "dist/**", "coverage/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.spec.ts",
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/bin/**",
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
        "src/core/secret-scanner/**": highRiskModuleThreshold,
        "src/core/secret-scanner.ts": highRiskModuleThreshold,
        "src/core/redactor/**": highRiskModuleThreshold,
        "src/core/redactor.ts": highRiskModuleThreshold,
        "src/core/sync-service/**": highRiskModuleThreshold,
        "src/core/sync-service.ts": highRiskModuleThreshold,
        "src/core/local-overwrite-gate/**": highRiskModuleThreshold,
        "src/core/local-overwrite-gate.ts": highRiskModuleThreshold,
      },
    },
  },
});
