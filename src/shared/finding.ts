// Task 7.2 (SecretScanner) will extend the scanner's Finding type and re-export it.
// This shape matches design.md's Finding contract so DomainError payloads can
// typecheck against findings emitted by later service code.
export type RedactedFinding = {
  readonly id: string;
  readonly filename: string;
  readonly line: number;
  readonly ruleId: string;
  readonly confidence: "high" | "medium" | "low";
  readonly redactedExcerpt: string;
};
