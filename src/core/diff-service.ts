import { createPatch } from "diff";

export type DiffInput = {
  readonly filename: string;
  readonly local: string;
  readonly remote: string;
  readonly limitBytes: number;
};

export type DiffResult =
  | { readonly kind: "diff"; readonly unified: string }
  | {
      readonly kind: "summary";
      readonly reason: "too_large" | "binary";
      readonly localSize: number;
      readonly remoteSize: number;
    };

export interface DiffService {
  diff(input: DiffInput): DiffResult;
}

function containsNullByte(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 0) return true;
  }
  return false;
}

export function createDiffService(): DiffService {
  function diff(input: DiffInput): DiffResult {
    const localSize = Buffer.byteLength(input.local, "utf8");
    const remoteSize = Buffer.byteLength(input.remote, "utf8");
    if (containsNullByte(input.local) || containsNullByte(input.remote)) {
      return { kind: "summary", reason: "binary", localSize, remoteSize };
    }
    if (localSize > input.limitBytes || remoteSize > input.limitBytes) {
      return { kind: "summary", reason: "too_large", localSize, remoteSize };
    }
    const unified = createPatch(input.filename, input.remote, input.local);
    if (Buffer.byteLength(unified, "utf8") > input.limitBytes) {
      return { kind: "summary", reason: "too_large", localSize, remoteSize };
    }
    return { kind: "diff", unified };
  }
  return { diff };
}
