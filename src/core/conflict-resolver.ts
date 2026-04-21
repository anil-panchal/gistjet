import type { ConflictReport } from "../shared/conflict";
import { err, ok, type Result } from "../shared/result";

export type Classification = "in_sync" | "local_ahead" | "remote_ahead" | "diverged";
export type ConflictStrategy = "prefer_local" | "prefer_remote" | "abort";
export type Direction = "push" | "pull" | "noop";

export type FileChange = {
  readonly filename: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly sizeBytes?: number;
};

export type ClassifyInput = {
  readonly current: {
    readonly localHash: string | null;
    readonly remoteRevision: string | null;
  };
  readonly lastKnown: {
    readonly localHash: string | null;
    readonly remoteRevision: string | null;
  };
};

export type Resolution = {
  readonly direction: Direction;
  readonly filesToWriteRemote: readonly FileChange[];
  readonly filesToWriteLocal: readonly FileChange[];
};

export type ConflictError = {
  readonly code: "E_CONFLICT";
  readonly report: ConflictReport;
};

export type ResolveInput = {
  readonly classification: Classification;
  readonly strategy: ConflictStrategy;
  readonly localChanges: readonly FileChange[];
  readonly remoteChanges: readonly FileChange[];
  readonly classifyInput: ClassifyInput;
};

export interface ConflictResolver {
  classify(input: ClassifyInput): Classification;
  resolve(input: ResolveInput): Result<Resolution, ConflictError>;
}

function buildReport(ci: ClassifyInput): ConflictReport {
  return {
    classification: "diverged",
    local: { hash: ci.current.localHash },
    remote: { revision: ci.current.remoteRevision },
    lastKnown: {
      localHash: ci.lastKnown.localHash,
      remoteRevision: ci.lastKnown.remoteRevision,
    },
  };
}

export function createConflictResolver(): ConflictResolver {
  function classify(input: ClassifyInput): Classification {
    const localChanged = input.current.localHash !== input.lastKnown.localHash;
    const remoteChanged = input.current.remoteRevision !== input.lastKnown.remoteRevision;
    if (!localChanged && !remoteChanged) return "in_sync";
    if (localChanged && !remoteChanged) return "local_ahead";
    if (!localChanged && remoteChanged) return "remote_ahead";
    return "diverged";
  }

  function resolve(input: ResolveInput): Result<Resolution, ConflictError> {
    const { classification, strategy, localChanges, remoteChanges, classifyInput } = input;
    const noop: Resolution = {
      direction: "noop",
      filesToWriteRemote: [],
      filesToWriteLocal: [],
    };
    if (classification === "in_sync") return ok(noop);
    if (classification === "diverged") {
      if (strategy === "prefer_local") {
        return ok({
          direction: "push",
          filesToWriteRemote: localChanges,
          filesToWriteLocal: [],
        });
      }
      if (strategy === "prefer_remote") {
        return ok({
          direction: "pull",
          filesToWriteRemote: [],
          filesToWriteLocal: remoteChanges,
        });
      }
      return err({ code: "E_CONFLICT", report: buildReport(classifyInput) });
    }
    // local_ahead / remote_ahead: abort means "make no changes"; other strategies
    // follow the natural direction.
    if (strategy === "abort") return ok(noop);
    if (classification === "local_ahead") {
      return ok({
        direction: "push",
        filesToWriteRemote: localChanges,
        filesToWriteLocal: [],
      });
    }
    return ok({
      direction: "pull",
      filesToWriteRemote: [],
      filesToWriteLocal: remoteChanges,
    });
  }

  return { classify, resolve };
}
