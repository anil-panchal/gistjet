export type RedactionRule = {
  readonly id: string;
  readonly pattern: RegExp;
  readonly replacement: string;
};

export interface Redactor {
  registerTokenValue(token: string): void;
  registerPattern(rule: RedactionRule): void;
  redactString(value: string): string;
  redactPayload<T>(payload: T): T;
}

export type CreateRedactorOptions = {
  readonly seedDefaults?: boolean;
};

const MIN_TOKEN_SUBSTRING = 10;
const TOKEN_REDACTION = "[REDACTED:token]";

const DEFAULT_PATTERNS: readonly RedactionRule[] = [
  {
    id: "github-pat-classic",
    pattern: /ghp_[A-Za-z0-9]{36,}/g,
    replacement: "[REDACTED:github-pat]",
  },
  {
    id: "github-oauth",
    pattern: /gho_[A-Za-z0-9]{36,}/g,
    replacement: "[REDACTED:github-oauth]",
  },
  {
    id: "github-pat-fine-grained",
    pattern: /github_pat_[A-Za-z0-9_]{20,}/g,
    replacement: "[REDACTED:github-pat]",
  },
  {
    id: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:aws]",
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
    replacement: "[REDACTED:google]",
  },
  {
    id: "stripe-live-key",
    pattern: /\bsk_live_[0-9a-zA-Z]{20,}\b/g,
    replacement: "[REDACTED:stripe]",
  },
  {
    id: "stripe-test-key",
    pattern: /\bsk_test_[0-9a-zA-Z]{20,}\b/g,
    replacement: "[REDACTED:stripe]",
  },
  {
    id: "slack-token",
    pattern: /\bxox[abpors]-[0-9a-zA-Z-]{10,}\b/g,
    replacement: "[REDACTED:slack]",
  },
  {
    id: "pem-private-key-header",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g,
    replacement: "[REDACTED:pem-header]",
  },
];

function ensureGlobal(re: RegExp): RegExp {
  return re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
}

function redactTokenSubstrings(text: string, token: string): string {
  if (token.length < MIN_TOKEN_SUBSTRING) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    let matched = 0;
    let len = MIN_TOKEN_SUBSTRING;
    while (i + len <= text.length && len <= token.length) {
      if (token.includes(text.slice(i, i + len))) {
        matched = len;
        len += 1;
      } else {
        break;
      }
    }
    if (matched >= MIN_TOKEN_SUBSTRING) {
      out += TOKEN_REDACTION;
      i += matched;
    } else {
      out += text.charAt(i);
      i += 1;
    }
  }
  return out;
}

function walkAndRedact(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      value[i] = walkAndRedact(value[i], redact);
    }
    return value;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      obj[key] = walkAndRedact(obj[key], redact);
    }
    return value;
  }
  return value;
}

export function createRedactor(options: CreateRedactorOptions = {}): Redactor {
  const rules: RedactionRule[] = options.seedDefaults === false ? [] : [...DEFAULT_PATTERNS];
  let tokenValue = "";

  function redactString(value: string): string {
    let result = value;
    for (const rule of rules) {
      result = result.replace(ensureGlobal(rule.pattern), rule.replacement);
    }
    if (tokenValue.length >= MIN_TOKEN_SUBSTRING) {
      result = redactTokenSubstrings(result, tokenValue);
    }
    return result;
  }

  return {
    registerTokenValue(token: string): void {
      tokenValue = token;
    },
    registerPattern(rule: RedactionRule): void {
      rules.push(rule);
    },
    redactString,
    redactPayload<T>(payload: T): T {
      const clone = structuredClone(payload);
      return walkAndRedact(clone, redactString) as T;
    },
  };
}
