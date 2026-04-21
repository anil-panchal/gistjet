import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  createConflictResolver,
  type ClassifyInput,
  type Classification,
  type ConflictStrategy,
  type FileChange,
} from "../../src/core/conflict-resolver";
import { isErr, isOk } from "../../src/shared/result";

function classifyInput(
  localHash: string | null,
  lastLocalHash: string | null,
  remoteRevision: string | null,
  lastRemoteRevision: string | null,
): ClassifyInput {
  return {
    current: { localHash, remoteRevision },
    lastKnown: { localHash: lastLocalHash, remoteRevision: lastRemoteRevision },
  };
}

const LOCAL_CHANGES: readonly FileChange[] = [
  { filename: "a.txt", kind: "modified", sizeBytes: 10 },
];
const REMOTE_CHANGES: readonly FileChange[] = [{ filename: "b.txt", kind: "added", sizeBytes: 20 }];

describe("ConflictResolver.classify (task 7.5, req 12.1)", () => {
  it("classifies in_sync when neither side has changed", () => {
    const resolver = createConflictResolver();
    expect(resolver.classify(classifyInput("H1", "H1", "R1", "R1"))).toBe("in_sync");
  });

  it("classifies local_ahead when only the local hash changed", () => {
    const resolver = createConflictResolver();
    expect(resolver.classify(classifyInput("H2", "H1", "R1", "R1"))).toBe("local_ahead");
  });

  it("classifies remote_ahead when only the remote revision changed", () => {
    const resolver = createConflictResolver();
    expect(resolver.classify(classifyInput("H1", "H1", "R2", "R1"))).toBe("remote_ahead");
  });

  it("classifies diverged when both sides changed (req 12.2)", () => {
    const resolver = createConflictResolver();
    expect(resolver.classify(classifyInput("H2", "H1", "R2", "R1"))).toBe("diverged");
  });

  it("handles null prior values as first-sync (no change on that side)", () => {
    const resolver = createConflictResolver();
    expect(resolver.classify(classifyInput(null, null, null, null))).toBe("in_sync");
  });
});

const CLASSIFICATIONS: readonly Classification[] = [
  "in_sync",
  "local_ahead",
  "remote_ahead",
  "diverged",
];
const STRATEGIES: readonly ConflictStrategy[] = ["prefer_local", "prefer_remote", "abort"];

describe("ConflictResolver.resolve 3x4 strategy × classification matrix (task 7.5, req 12.3, 12.4, 12.5)", () => {
  const resolver = createConflictResolver();
  const ci = classifyInput("H2", "H1", "R2", "R1");
  const NON_ABORT: readonly ConflictStrategy[] = ["prefer_local", "prefer_remote"];

  it.each(STRATEGIES)("in_sync under strategy=%s → noop", (strategy) => {
    const r = resolver.resolve({
      classification: "in_sync",
      strategy,
      localChanges: LOCAL_CHANGES,
      remoteChanges: REMOTE_CHANGES,
      classifyInput: ci,
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.direction).toBe("noop");
    expect(r.value.filesToWriteRemote).toEqual([]);
    expect(r.value.filesToWriteLocal).toEqual([]);
  });

  it.each(NON_ABORT)("local_ahead under strategy=%s → push with localChanges", (strategy) => {
    const r = resolver.resolve({
      classification: "local_ahead",
      strategy,
      localChanges: LOCAL_CHANGES,
      remoteChanges: REMOTE_CHANGES,
      classifyInput: ci,
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.direction).toBe("push");
    expect(r.value.filesToWriteRemote).toEqual(LOCAL_CHANGES);
    expect(r.value.filesToWriteLocal).toEqual([]);
  });

  it("local_ahead under strategy=abort → noop (req 12.5: make no changes)", () => {
    const r = resolver.resolve({
      classification: "local_ahead",
      strategy: "abort",
      localChanges: LOCAL_CHANGES,
      remoteChanges: REMOTE_CHANGES,
      classifyInput: ci,
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.direction).toBe("noop");
    expect(r.value.filesToWriteRemote).toEqual([]);
    expect(r.value.filesToWriteLocal).toEqual([]);
  });

  it.each(NON_ABORT)("remote_ahead under strategy=%s → pull with remoteChanges", (strategy) => {
    const r = resolver.resolve({
      classification: "remote_ahead",
      strategy,
      localChanges: LOCAL_CHANGES,
      remoteChanges: REMOTE_CHANGES,
      classifyInput: ci,
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.direction).toBe("pull");
    expect(r.value.filesToWriteLocal).toEqual(REMOTE_CHANGES);
    expect(r.value.filesToWriteRemote).toEqual([]);
  });

  it("remote_ahead under strategy=abort → noop (req 12.5: make no changes)", () => {
    const r = resolver.resolve({
      classification: "remote_ahead",
      strategy: "abort",
      localChanges: LOCAL_CHANGES,
      remoteChanges: REMOTE_CHANGES,
      classifyInput: ci,
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.direction).toBe("noop");
    expect(r.value.filesToWriteLocal).toEqual([]);
  });

  it("diverged + prefer_local → push with localChanges", () => {
    const r = resolver.resolve({
      classification: "diverged",
      strategy: "prefer_local",
      localChanges: LOCAL_CHANGES,
      remoteChanges: REMOTE_CHANGES,
      classifyInput: ci,
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.direction).toBe("push");
    expect(r.value.filesToWriteRemote).toEqual(LOCAL_CHANGES);
    expect(r.value.filesToWriteLocal).toEqual([]);
  });

  it("diverged + prefer_remote → pull with remoteChanges", () => {
    const r = resolver.resolve({
      classification: "diverged",
      strategy: "prefer_remote",
      localChanges: LOCAL_CHANGES,
      remoteChanges: REMOTE_CHANGES,
      classifyInput: ci,
    });
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.direction).toBe("pull");
    expect(r.value.filesToWriteLocal).toEqual(REMOTE_CHANGES);
    expect(r.value.filesToWriteRemote).toEqual([]);
  });

  it("diverged + abort → E_CONFLICT with a detailed conflict report (req 12.5)", () => {
    const r = resolver.resolve({
      classification: "diverged",
      strategy: "abort",
      localChanges: LOCAL_CHANGES,
      remoteChanges: REMOTE_CHANGES,
      classifyInput: ci,
    });
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("E_CONFLICT");
    expect(r.error.report.classification).toBe("diverged");
    expect(r.error.report.local.hash).toBe("H2");
    expect(r.error.report.remote.revision).toBe("R2");
    expect(r.error.report.lastKnown.localHash).toBe("H1");
    expect(r.error.report.lastKnown.remoteRevision).toBe("R1");
  });
});

describe("ConflictResolver property-based assertions (task 7.5)", () => {
  const resolver = createConflictResolver();
  const hashArb = fc.option(fc.hexaString({ minLength: 4, maxLength: 64 }), { nil: null });
  const revArb = fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: null });

  it("classify is total over every (local hash, remote revision, last known) tuple", () => {
    fc.assert(
      fc.property(hashArb, hashArb, revArb, revArb, (lh, lastLh, rr, lastRr) => {
        const out = resolver.classify(classifyInput(lh, lastLh, rr, lastRr));
        expect(CLASSIFICATIONS).toContain(out);
      }),
      { numRuns: 300 },
    );
  });

  it("classify is idempotent — same inputs always produce the same classification", () => {
    fc.assert(
      fc.property(hashArb, hashArb, revArb, revArb, (lh, lastLh, rr, lastRr) => {
        const input = classifyInput(lh, lastLh, rr, lastRr);
        const a = resolver.classify(input);
        const b = resolver.classify(input);
        expect(a).toBe(b);
      }),
      { numRuns: 300 },
    );
  });

  it("resolve composed with classify never writes local files under the abort strategy", () => {
    fc.assert(
      fc.property(hashArb, hashArb, revArb, revArb, (lh, lastLh, rr, lastRr) => {
        const ci = classifyInput(lh, lastLh, rr, lastRr);
        const classification = resolver.classify(ci);
        const result = resolver.resolve({
          classification,
          strategy: "abort",
          localChanges: LOCAL_CHANGES,
          remoteChanges: REMOTE_CHANGES,
          classifyInput: ci,
        });
        if (isOk(result)) {
          expect(result.value.filesToWriteLocal).toEqual([]);
        } else {
          expect(result.error.code).toBe("E_CONFLICT");
        }
      }),
      { numRuns: 300 },
    );
  });
});
