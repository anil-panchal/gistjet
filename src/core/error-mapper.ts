import type { DomainError, McpToolError } from "../shared/error";
import type { Result } from "../shared/result";

const AUTH_MESSAGES: Record<Extract<DomainError, { code: "E_AUTH" }>["detail"], string> = {
  invalid_token: "GitHub token is invalid or expired.",
  missing_permission:
    "GitHub token is missing the required Gists permission (classic: gist scope, fine-grained: Gists read+write).",
  missing_token:
    "No GitHub token configured. Set GISTJET_GITHUB_TOKEN or GITHUB_TOKEN and restart.",
  network: "Network error while verifying the GitHub token.",
};

function serializeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return cause;
}

export function toMcp(error: DomainError, requestId: string): McpToolError {
  switch (error.code) {
    case "E_INPUT":
      return {
        code: "E_INPUT",
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
        requestId,
      };

    case "E_NOT_FOUND": {
      const idSuffix = error.identifier != null ? ` (${String(error.identifier)})` : "";
      return {
        code: "E_NOT_FOUND",
        message: `Not found: ${error.resource}${idSuffix}.`,
        details: { resource: error.resource, identifier: error.identifier ?? null },
        requestId,
      };
    }

    case "E_EXISTS":
      return {
        code: "E_EXISTS",
        message: `Already exists at ${error.path}.`,
        details: { path: error.path },
        requestId,
      };

    case "E_AUTH":
      return {
        code: "E_AUTH",
        message: AUTH_MESSAGES[error.detail],
        details: { detail: error.detail },
        requestId,
      };

    case "E_RATE_LIMIT":
      return {
        code: "E_RATE_LIMIT",
        message: `GitHub rate limit reached; resets at ${error.resetAt}.`,
        details: { resetAt: error.resetAt },
        requestId,
      };

    case "E_CONFLICT":
      return {
        code: "E_CONFLICT",
        message:
          "Local and remote have diverged; choose an on_conflict strategy (prefer_local, prefer_remote, or abort).",
        details: { classification: error.classification, report: error.report },
        requestId,
      };

    case "E_ORPHANED":
      return {
        code: "E_ORPHANED",
        message: "Mapping references a gist that is no longer accessible.",
        details: { mappingId: error.mappingId },
        requestId,
      };

    case "E_LOCAL_MISSING":
      return {
        code: "E_LOCAL_MISSING",
        message: `Mapped local path is missing: ${error.path}.`,
        details: { mappingId: error.mappingId, path: error.path },
        requestId,
      };

    case "E_LOCAL_OVERWRITE_CONFIRM":
      return {
        code: "E_LOCAL_OVERWRITE_CONFIRM",
        message: `Refusing to overwrite ${error.files.length} local file(s) without confirm_overwrite_local: true.`,
        details: { files: error.files },
        requestId,
      };

    case "E_SECRET_DETECTED":
      return {
        code: "E_SECRET_DETECTED",
        message: `${error.findings.length} secret finding(s) blocking publish.`,
        details: { findings: error.findings },
        requestId,
      };

    case "E_VISIBILITY_CONFIRM":
      return {
        code: "E_VISIBILITY_CONFIRM",
        message: "Public visibility requires confirm_public: true.",
        requestId,
      };

    case "E_VISIBILITY_CHANGE_REFUSED":
      return {
        code: "E_VISIBILITY_CHANGE_REFUSED",
        message:
          "Visibility cannot be changed via sync. Unlink the mapping and re-publish with the desired visibility.",
        requestId,
      };

    case "E_TOO_LARGE":
      return {
        code: "E_TOO_LARGE",
        message: `${error.file} exceeds the size limit (${error.sizeBytes} > ${error.limit} bytes).`,
        details: { file: error.file, sizeBytes: error.sizeBytes, limit: error.limit },
        requestId,
      };

    case "E_TOO_MANY_FILES":
      return {
        code: "E_TOO_MANY_FILES",
        message: `Publish would exceed the GitHub gist file-count limit (${error.count} > ${error.limit}).`,
        details: { count: error.count, limit: error.limit },
        requestId,
      };

    case "E_BINARY":
      return {
        code: "E_BINARY",
        message: `${error.file} is binary. Pass allow_binary: true to include it.`,
        details: { file: error.file },
        requestId,
      };

    case "E_FILENAME_COLLISION":
      return {
        code: "E_FILENAME_COLLISION",
        message: `${error.groups.length} flattened gist filename collision(s); rename sources to avoid clash.`,
        details: { groups: error.groups },
        requestId,
      };

    case "E_POST_PUBLISH_MISMATCH":
      return {
        code: "E_POST_PUBLISH_MISMATCH",
        message: `Post-publish verification failed for gist ${error.gistId}; no mapping persisted.`,
        details: {
          gistId: error.gistId,
          htmlUrl: error.htmlUrl,
          mismatched: error.mismatched,
        },
        requestId,
      };

    case "E_SCHEMA_NEWER":
      return {
        code: "E_SCHEMA_NEWER",
        message: `.gistjet.json schema is newer than supported (required ${error.required}, found ${error.found}).`,
        details: { required: error.required, found: error.found },
        requestId,
      };

    case "E_PARSE":
      return {
        code: "E_PARSE",
        message: `Failed to parse .gistjet.json: ${error.cause}.`,
        details: { cause: error.cause },
        requestId,
      };

    case "E_IO":
      return {
        code: "E_IO",
        message: `I/O error on ${error.path}: ${error.cause}.`,
        details: { path: error.path, cause: error.cause },
        requestId,
      };

    case "E_INTERNAL": {
      const base = {
        code: "E_INTERNAL" as const,
        message: "Internal error.",
        requestId,
      };
      if (error.cause === undefined) return base;
      return { ...base, details: { cause: serializeCause(error.cause) } };
    }

    default: {
      const _never: never = error;
      void _never;
      return { code: "E_INTERNAL", message: "Unknown error.", requestId };
    }
  }
}

export function catchUnexpected(cause: unknown): DomainError {
  return { code: "E_INTERNAL", cause };
}

export async function guardAsync<T>(
  fn: () => Promise<Result<T, DomainError>>,
): Promise<Result<T, DomainError>> {
  try {
    return await fn();
  } catch (cause) {
    return { ok: false, error: catchUnexpected(cause) };
  }
}
