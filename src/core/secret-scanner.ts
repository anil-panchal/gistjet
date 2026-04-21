import { createHash } from "node:crypto";

import type { RedactionRule, Redactor } from "./redactor";

export type SecretConfidence = "high" | "medium" | "low";

export type SecretRule = {
  readonly id: string;
  readonly pattern: RegExp;
  readonly confidence: SecretConfidence;
  readonly entropyGate?: boolean;
  readonly entropyCaptureGroup?: number;
};

export type Finding = {
  readonly id: string;
  readonly filename: string;
  readonly line: number;
  readonly ruleId: string;
  readonly confidence: SecretConfidence;
  readonly redactedExcerpt: string;
};

export type ScanInput = {
  readonly filename: string;
  readonly content: string;
};

export type ScanOptions = {
  readonly acknowledgeFindings?: readonly string[];
  readonly bypassScan?: boolean;
};

export type ScanReport = {
  readonly findings: readonly Finding[];
  readonly blocking: readonly Finding[];
};

export interface SecretScanner {
  scan(files: readonly ScanInput[], options?: ScanOptions): Promise<ScanReport>;
}

export const SECRET_RULES: readonly SecretRule[] = [
  { id: "github-pat-classic", pattern: /ghp_[A-Za-z0-9]{36,}/g, confidence: "high" },
  { id: "github-oauth", pattern: /gho_[A-Za-z0-9]{36,}/g, confidence: "high" },
  {
    id: "github-pat-fine-grained",
    pattern: /github_pat_[A-Za-z0-9_]{22,}/g,
    confidence: "high",
  },
  { id: "github-app-token", pattern: /gh[usr]_[A-Za-z0-9]{36,}/g, confidence: "high" },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, confidence: "high" },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g, confidence: "high" },
  { id: "stripe-live-key", pattern: /\bsk_live_[0-9a-zA-Z]{20,}\b/g, confidence: "high" },
  { id: "stripe-test-key", pattern: /\bsk_test_[0-9a-zA-Z]{20,}\b/g, confidence: "high" },
  { id: "slack-token", pattern: /\bxox[abpors]-[0-9a-zA-Z-]{10,}\b/g, confidence: "high" },
  {
    id: "pem-private-key-header",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g,
    confidence: "high",
  },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g, confidence: "high" },
  {
    id: "sendgrid-api-key",
    pattern: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/g,
    confidence: "high",
  },
  { id: "mailgun-api-key", pattern: /\bkey-[a-f0-9]{32}\b/g, confidence: "high" },
  { id: "twilio-api-key", pattern: /\bSK[a-f0-9]{32}\b/g, confidence: "high" },
  {
    id: "azure-storage-key",
    pattern: /AccountKey=[A-Za-z0-9+/=]{40,}/g,
    confidence: "high",
  },
  {
    id: "discord-bot-token",
    pattern: /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}\b/g,
    confidence: "high",
  },
  {
    id: "jwt-token",
    pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
    confidence: "medium",
    entropyGate: true,
  },
  {
    id: "generic-high-entropy-kv",
    pattern: /^([A-Z][A-Z0-9_]*)\s*=\s*(\S{20,})$/gm,
    confidence: "low",
    entropyGate: true,
    entropyCaptureGroup: 2,
  },
];

const ENTROPY_THRESHOLD = 4.2;
const MIN_ENTROPY_LEN = 20;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const len = value.length;
  let h = 0;
  for (const count of counts.values()) {
    const p = count / len;
    h -= p * Math.log2(p);
  }
  return h;
}

function lineNumberOf(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

function redactMatch(raw: string, ruleId: string): string {
  return `[${ruleId}] ${raw.slice(0, 2)}…${raw.slice(-2)}`;
}

function deterministicId(ruleId: string, filename: string, line: number, excerpt: string): string {
  return createHash("sha256")
    .update(`${ruleId}|${filename}|${line}|${excerpt}`)
    .digest("hex")
    .slice(0, 12);
}

export function createSecretScanner(): SecretScanner {
  async function scan(files: readonly ScanInput[], options: ScanOptions = {}): Promise<ScanReport> {
    const ackSet = new Set(options.acknowledgeFindings ?? []);
    const findings: Finding[] = [];
    for (const file of files) {
      for (const rule of SECRET_RULES) {
        const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
        let execMatch: RegExpExecArray | null;
        while ((execMatch = pattern.exec(file.content)) !== null) {
          const matched = execMatch[0];
          if (rule.entropyGate) {
            const target =
              rule.entropyCaptureGroup !== undefined
                ? execMatch[rule.entropyCaptureGroup]
                : matched;
            if (
              target === undefined ||
              target.length < MIN_ENTROPY_LEN ||
              shannonEntropy(target) < ENTROPY_THRESHOLD
            ) {
              continue;
            }
          }
          const line = lineNumberOf(file.content, execMatch.index);
          const redactedExcerpt = redactMatch(matched, rule.id);
          const id = deterministicId(rule.id, file.filename, line, redactedExcerpt);
          findings.push({
            id,
            filename: file.filename,
            line,
            ruleId: rule.id,
            confidence: rule.confidence,
            redactedExcerpt,
          });
        }
      }
    }
    const blocking = findings.filter((f) => {
      if (f.confidence === "high") return true;
      if (options.bypassScan === true) return false;
      if (ackSet.has(f.id)) return false;
      return true;
    });
    return { findings, blocking };
  }
  return { scan };
}

export function registerScannerRulesWithRedactor(redactor: Redactor): void {
  for (const rule of SECRET_RULES) {
    if (rule.confidence !== "high") continue;
    const redRule: RedactionRule = {
      id: `scanner-${rule.id}`,
      pattern: new RegExp(rule.pattern.source, rule.pattern.flags),
      replacement: `[REDACTED:${rule.id}]`,
    };
    redactor.registerPattern(redRule);
  }
}
