import { err, ok, type Result } from "../shared/result";

import type { IgnoreMatcher } from "./ignore-engine";

export type PlannedWrite = {
  readonly relativePath: string;
  readonly sizeBytes: number;
};

export type OverwriteInput = {
  readonly plannedWrites: readonly PlannedWrite[];
  readonly confirmOverwriteLocal?: boolean;
  readonly ignoreMatcher: IgnoreMatcher;
};

export type OverwriteDecision = {
  readonly approved: readonly PlannedWrite[];
  readonly ignoredOnPull: readonly string[];
};

export type OverwriteError = {
  readonly code: "E_LOCAL_OVERWRITE_CONFIRM";
  readonly files: readonly PlannedWrite[];
};

export interface LocalOverwriteGate {
  authorize(input: OverwriteInput): Result<OverwriteDecision, OverwriteError>;
}

export function createLocalOverwriteGate(): LocalOverwriteGate {
  function authorize(input: OverwriteInput): Result<OverwriteDecision, OverwriteError> {
    const approved: PlannedWrite[] = [];
    const ignoredOnPull: string[] = [];
    for (const write of input.plannedWrites) {
      if (input.ignoreMatcher.isIgnored(write.relativePath)) {
        ignoredOnPull.push(write.relativePath);
      } else {
        approved.push(write);
      }
    }
    if (approved.length > 0 && input.confirmOverwriteLocal !== true) {
      return err({ code: "E_LOCAL_OVERWRITE_CONFIRM", files: approved });
    }
    return ok({ approved, ignoredOnPull });
  }
  return { authorize };
}
