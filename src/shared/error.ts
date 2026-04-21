import type { ConflictReport } from "./conflict";
import type { RedactedFinding } from "./finding";

export const ERROR_CODES = [
  "E_INPUT",
  "E_NOT_FOUND",
  "E_EXISTS",
  "E_AUTH",
  "E_RATE_LIMIT",
  "E_CONFLICT",
  "E_ORPHANED",
  "E_LOCAL_MISSING",
  "E_LOCAL_OVERWRITE_CONFIRM",
  "E_SECRET_DETECTED",
  "E_VISIBILITY_CONFIRM",
  "E_VISIBILITY_CHANGE_REFUSED",
  "E_TOO_LARGE",
  "E_TOO_MANY_FILES",
  "E_BINARY",
  "E_FILENAME_COLLISION",
  "E_POST_PUBLISH_MISMATCH",
  "E_SCHEMA_NEWER",
  "E_PARSE",
  "E_IO",
  "E_INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type McpToolError = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  readonly requestId: string;
};

export type DomainError =
  | {
      readonly code: "E_INPUT";
      readonly message: string;
      readonly details?: Record<string, unknown>;
    }
  | {
      readonly code: "E_NOT_FOUND";
      readonly resource: string;
      readonly identifier?: string | number | null;
    }
  | { readonly code: "E_EXISTS"; readonly path: string }
  | {
      readonly code: "E_AUTH";
      readonly detail: "invalid_token" | "missing_permission" | "missing_token" | "network";
    }
  | { readonly code: "E_RATE_LIMIT"; readonly resetAt: string }
  | {
      readonly code: "E_CONFLICT";
      readonly classification: "diverged";
      readonly report: ConflictReport;
    }
  | { readonly code: "E_ORPHANED"; readonly mappingId: string }
  | { readonly code: "E_LOCAL_MISSING"; readonly mappingId: string; readonly path: string }
  | {
      readonly code: "E_LOCAL_OVERWRITE_CONFIRM";
      readonly files: ReadonlyArray<{ readonly path: string; readonly sizeBytes: number }>;
    }
  | { readonly code: "E_SECRET_DETECTED"; readonly findings: readonly RedactedFinding[] }
  | { readonly code: "E_VISIBILITY_CONFIRM" }
  | { readonly code: "E_VISIBILITY_CHANGE_REFUSED" }
  | {
      readonly code: "E_TOO_LARGE";
      readonly file: string;
      readonly sizeBytes: number;
      readonly limit: number;
    }
  | { readonly code: "E_TOO_MANY_FILES"; readonly count: number; readonly limit: number }
  | { readonly code: "E_BINARY"; readonly file: string }
  | {
      readonly code: "E_FILENAME_COLLISION";
      readonly groups: ReadonlyArray<{
        readonly flattened: string;
        readonly sources: readonly string[];
      }>;
    }
  | {
      readonly code: "E_POST_PUBLISH_MISMATCH";
      readonly gistId: string;
      readonly htmlUrl: string;
      readonly mismatched: readonly string[];
    }
  | { readonly code: "E_SCHEMA_NEWER"; readonly required: number; readonly found: number }
  | { readonly code: "E_PARSE"; readonly cause: string }
  | { readonly code: "E_IO"; readonly path: string; readonly cause: string }
  | { readonly code: "E_INTERNAL"; readonly cause?: unknown };

// Compile-time guard that every ErrorCode appears in ERROR_CODES and vice versa.
// If a code is missing, this type becomes `never` and the `true` assignment fails.
type _ExhaustiveErrorCodes =
  Exclude<ErrorCode, (typeof ERROR_CODES)[number]> extends never
    ? Exclude<(typeof ERROR_CODES)[number], ErrorCode> extends never
      ? true
      : never
    : never;
const _exhaustive: _ExhaustiveErrorCodes = true;
void _exhaustive;
