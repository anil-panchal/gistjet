import { err, ok, type Result } from "../shared/result";

export type FlattenInput = {
  readonly relativePath: string;
  readonly sizeBytes: number;
};

export type FlattenedFile = {
  readonly relativePath: string;
  readonly flattenedFilename: string;
  readonly sizeBytes: number;
};

export type FlattenDecision = {
  readonly files: readonly FlattenedFile[];
};

export type CollisionGroup = {
  readonly flattened: string;
  readonly sources: readonly string[];
};

export type FilenameCollisionError = {
  readonly code: "E_FILENAME_COLLISION";
  readonly groups: readonly CollisionGroup[];
};

export interface FilenameFlattener {
  flatten(inputs: readonly FlattenInput[]): Result<FlattenDecision, FilenameCollisionError>;
}

const SEPARATOR = "__";
const SAFE_CHAR = /^[A-Za-z0-9.\-]$/;

function encodeSegment(segment: string): string {
  let out = "";
  for (const char of segment) {
    if (SAFE_CHAR.test(char)) {
      out += char;
    } else {
      for (const byte of new TextEncoder().encode(char)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

export function flattenPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.split("/").map(encodeSegment).join(SEPARATOR);
}

export function unflatten(flattenedFilename: string): string {
  return flattenedFilename
    .split(SEPARATOR)
    .map((seg) => decodeURIComponent(seg))
    .join("/");
}

export function createFilenameFlattener(): FilenameFlattener {
  function flatten(
    inputs: readonly FlattenInput[],
  ): Result<FlattenDecision, FilenameCollisionError> {
    const files: FlattenedFile[] = inputs.map((input) => ({
      relativePath: input.relativePath,
      flattenedFilename: flattenPath(input.relativePath),
      sizeBytes: input.sizeBytes,
    }));
    const grouped = new Map<string, string[]>();
    for (const file of files) {
      const bucket = grouped.get(file.flattenedFilename);
      if (bucket) {
        bucket.push(file.relativePath);
      } else {
        grouped.set(file.flattenedFilename, [file.relativePath]);
      }
    }
    const collisions: CollisionGroup[] = [];
    for (const [flattened, sources] of grouped) {
      if (sources.length > 1) collisions.push({ flattened, sources });
    }
    if (collisions.length > 0) {
      return err({ code: "E_FILENAME_COLLISION", groups: collisions });
    }
    return ok({ files });
  }
  return { flatten };
}
