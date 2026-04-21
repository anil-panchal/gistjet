import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRedactor } from "../../src/core/redactor";
import {
  createSecretScanner,
  registerScannerRulesWithRedactor,
  SECRET_RULES,
} from "../../src/core/secret-scanner";
import type { Finding } from "../../src/core/secret-scanner";

const FIXTURES_ROOT = join(__dirname, "..", "fixtures", "scanner");

function loadFixtures(
  bucket: "positive" | "negative",
): Array<{ filename: string; content: string }> {
  const dir = join(FIXTURES_ROOT, bucket);
  return readdirSync(dir)
    .sort()
    .map((name) => ({ filename: name, content: readFileSync(join(dir, name), "utf8") }));
}

function normalizeSnapshot(findings: readonly Finding[]): Array<Omit<Finding, "id">> {
  return findings
    .map(({ filename, line, ruleId, confidence, redactedExcerpt }) => ({
      filename,
      line,
      ruleId,
      confidence,
      redactedExcerpt,
    }))
    .sort((a, b) => {
      if (a.filename !== b.filename) return a.filename.localeCompare(b.filename);
      if (a.line !== b.line) return a.line - b.line;
      return a.ruleId.localeCompare(b.ruleId);
    });
}

describe("SecretScanner rule pack (task 7.2, req 8.1)", () => {
  it("ships at least 15 high-confidence credential classes", () => {
    const highRules = SECRET_RULES.filter((r) => r.confidence === "high");
    expect(highRules.length).toBeGreaterThanOrEqual(15);
  });

  it("only applies Shannon-entropy gating for medium/low rules", () => {
    const entropyGated = SECRET_RULES.filter((r) => r.entropyGate === true);
    for (const rule of entropyGated) {
      expect(rule.confidence).not.toBe("high");
    }
  });
});

describe("SecretScanner.scan basic detection (task 7.2, req 8.1, 8.2)", () => {
  it("flags a GitHub PAT as high-confidence blocking", async () => {
    const scanner = createSecretScanner();
    const report = await scanner.scan([
      { filename: "cfg.env", content: "TOKEN=ghp_aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQ12\n" },
    ]);
    const gh = report.findings.find((f) => f.ruleId === "github-pat-classic");
    expect(gh).toBeDefined();
    expect(gh?.confidence).toBe("high");
    expect(gh?.line).toBe(1);
    expect(report.blocking).toContainEqual(gh);
  });

  it("reports accurate line numbers for a match on a later line", async () => {
    const scanner = createSecretScanner();
    const report = await scanner.scan([
      {
        filename: "multiline.env",
        content: "HELLO=world\n\nSTRIPE_KEY=sk_live_4242424242424242ABCDEFGH\n",
      },
    ]);
    const stripe = report.findings.find((f) => f.ruleId === "stripe-live-key");
    expect(stripe?.line).toBe(3);
  });

  it("produces no findings for a negative fixture", async () => {
    const scanner = createSecretScanner();
    const report = await scanner.scan([
      { filename: "clean.ts", content: "export const greeting = 'hello world';\n" },
    ]);
    expect(report.findings).toHaveLength(0);
    expect(report.blocking).toHaveLength(0);
  });
});

describe("SecretScanner redaction (task 7.2, req 8.4)", () => {
  it("never returns the raw matched secret in redactedExcerpt", async () => {
    const scanner = createSecretScanner();
    const raw = "ghp_aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQ12";
    const report = await scanner.scan([{ filename: "cfg.env", content: `TOKEN=${raw}\n` }]);
    for (const finding of report.findings) {
      expect(finding.redactedExcerpt).not.toContain(raw);
    }
  });

  it("shows only the match type plus first/last two characters of the match", async () => {
    const scanner = createSecretScanner();
    const raw = "ghp_aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQ12";
    const report = await scanner.scan([{ filename: "cfg.env", content: `TOKEN=${raw}\n` }]);
    const finding = report.findings.find((f) => f.ruleId === "github-pat-classic");
    expect(finding?.redactedExcerpt).toBe("[github-pat-classic] gh…12");
  });
});

describe("SecretScanner finding identity (task 7.2)", () => {
  it("produces deterministic finding ids across repeat scans", async () => {
    const scanner = createSecretScanner();
    const input = [
      {
        filename: "cfg.env",
        content: "TOKEN=ghp_aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQ12\n",
      },
    ];
    const first = await scanner.scan(input);
    const second = await scanner.scan(input);
    expect(first.findings.map((f) => f.id)).toEqual(second.findings.map((f) => f.id));
  });

  it("assigns different finding ids to two distinct matches on different lines", async () => {
    const scanner = createSecretScanner();
    const report = await scanner.scan([
      {
        filename: "cfg.env",
        content:
          "A=ghp_aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQ12\nB=ghp_zZyYxXwWvVuUtTsSrRqQpPoOnNmMlLkKjJ99\n",
      },
    ]);
    const ids = report.findings.filter((f) => f.ruleId === "github-pat-classic").map((f) => f.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("SecretScanner JWT entropy gating (task 7.2)", () => {
  const realisticJwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwibmFtZSI6IkFsaWNlIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  it("flags a realistic JWT (passes entropy gate) as a medium finding", async () => {
    const scanner = createSecretScanner();
    const report = await scanner.scan([
      { filename: "auth.txt", content: `AUTH=${realisticJwt}\n` },
    ]);
    const jwt = report.findings.find((f) => f.ruleId === "jwt-token");
    expect(jwt).toBeDefined();
    expect(jwt?.confidence).toBe("medium");
  });

  it("skips a JWT-shaped string whose entropy is below the threshold", async () => {
    const scanner = createSecretScanner();
    const lowEntropyJwt = "eyJaaaaaaaaaaa.eyJaaaaaaaaaaa.aaaaaaaaaaa";
    const report = await scanner.scan([{ filename: "fake.txt", content: `${lowEntropyJwt}\n` }]);
    const jwt = report.findings.find((f) => f.ruleId === "jwt-token");
    expect(jwt).toBeUndefined();
  });
});

describe("SecretScanner acknowledge_findings gate (task 7.2, req 8.3)", () => {
  const highEntropyContent =
    "DATABASE_URL=postgres://app:pass@db/app\nSESSION_SECRET=K9#xqzV2pMj4Rw7tLs8nE1uYbH0cA3fD6gIoQvNk\n";

  it("blocks medium/low findings by default when the caller does not acknowledge them", async () => {
    const scanner = createSecretScanner();
    const report = await scanner.scan([{ filename: ".env", content: highEntropyContent }]);
    const entropyFinding = report.findings.find(
      (f) => f.confidence !== "high" && f.ruleId.startsWith("generic-"),
    );
    expect(entropyFinding).toBeDefined();
    expect(report.blocking).toContainEqual(entropyFinding);
  });

  it("removes acknowledged medium/low findings from the blocking list", async () => {
    const scanner = createSecretScanner();
    const first = await scanner.scan([{ filename: ".env", content: highEntropyContent }]);
    const toAck = first.findings.filter((f) => f.confidence !== "high").map((f) => f.id);
    expect(toAck.length).toBeGreaterThan(0);
    const second = await scanner.scan([{ filename: ".env", content: highEntropyContent }], {
      acknowledgeFindings: toAck,
    });
    const mediumBlockers = second.blocking.filter((f) => f.confidence !== "high");
    expect(mediumBlockers).toHaveLength(0);
    // Findings are still reported even when acknowledged:
    expect(second.findings.length).toBe(first.findings.length);
  });

  it("does not change the list of reported findings when acknowledging a subset", async () => {
    const scanner = createSecretScanner();
    const report = await scanner.scan([{ filename: ".env", content: highEntropyContent }], {
      acknowledgeFindings: ["unknown-id-that-matches-nothing"],
    });
    expect(report.findings.length).toBeGreaterThan(0);
  });
});

describe("SecretScanner bypass_scan gate (task 7.2, req 8.5)", () => {
  it("keeps high-confidence findings blocking even when bypass_scan is true", async () => {
    const scanner = createSecretScanner();
    const report = await scanner.scan(
      [{ filename: "key.pem", content: "-----BEGIN RSA PRIVATE KEY-----\nabc\n" }],
      { bypassScan: true },
    );
    const pem = report.findings.find((f) => f.ruleId === "pem-private-key-header");
    expect(pem?.confidence).toBe("high");
    expect(report.blocking).toContainEqual(pem);
  });

  it("removes medium/low findings from the blocking list when bypass_scan is true", async () => {
    const scanner = createSecretScanner();
    const report = await scanner.scan(
      [
        {
          filename: ".env",
          content: "SESSION_SECRET=K9#xqzV2pMj4Rw7tLs8nE1uYbH0cA3fD6gIoQvNk\n",
        },
      ],
      { bypassScan: true },
    );
    const medium = report.blocking.filter((f) => f.confidence !== "high");
    expect(medium).toHaveLength(0);
  });
});

describe("SecretScanner redactor coordination (task 7.2, req 8.4)", () => {
  it("registerScannerRulesWithRedactor masks the same substrings the scanner flags", () => {
    const redactor = createRedactor({ seedDefaults: false });
    registerScannerRulesWithRedactor(redactor);
    const redacted = redactor.redactString(
      "TOKEN=ghp_aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQ12 AWS=AKIAIOSFODNN7EXAMPLE",
    );
    expect(redacted).not.toContain("ghp_aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQ12");
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("SecretScanner golden corpus (task 7.2)", () => {
  it("matches the snapshot for every positive fixture", async () => {
    const scanner = createSecretScanner();
    const inputs = loadFixtures("positive");
    const report = await scanner.scan(inputs);
    expect(normalizeSnapshot(report.findings)).toMatchSnapshot();
  });

  it("produces zero findings for every negative fixture", async () => {
    const scanner = createSecretScanner();
    const inputs = loadFixtures("negative");
    const report = await scanner.scan(inputs);
    expect(report.findings).toEqual([]);
  });
});
