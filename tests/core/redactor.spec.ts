import { describe, expect, it } from "vitest";

import { createRedactor } from "../../src/core/redactor";

const GHP_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

describe("redactor — token substring masking (task 3.2)", () => {
  it("masks contiguous substrings of length ≥ 10 that appear in the registered token", () => {
    const r = createRedactor();
    r.registerTokenValue(GHP_TOKEN);
    const out = r.redactString(`use token ghp_ABCDEFGHIJ elsewhere`);
    expect(out).not.toContain("ghp_ABCDEFGHIJ");
    expect(out).toContain("[REDACTED");
  });

  it("masks the longest matching substring at each position (greedy)", () => {
    const r = createRedactor({ seedDefaults: false });
    r.registerTokenValue(GHP_TOKEN);
    const prefix = GHP_TOKEN.slice(0, 20);
    const out = r.redactString(`header ${prefix} footer`);
    expect(out).not.toContain(prefix);
    // Longer match produces a single redaction marker, not many.
    expect(out.match(/\[REDACTED/g)).toHaveLength(1);
  });

  it("leaves substrings shorter than 10 chars intact", () => {
    const r = createRedactor({ seedDefaults: false });
    r.registerTokenValue(GHP_TOKEN);
    // "ghp_ABCDE" = 9 chars
    const out = r.redactString("snippet ghp_ABCDE here");
    expect(out).toContain("ghp_ABCDE");
  });

  it("no-ops when no token is registered", () => {
    const r = createRedactor({ seedDefaults: false });
    const text = "nothing to redact here 1234567890";
    expect(r.redactString(text)).toBe(text);
  });

  it("ignores tokens shorter than 10 chars", () => {
    const r = createRedactor({ seedDefaults: false });
    r.registerTokenValue("short");
    expect(r.redactString("short string")).toBe("short string");
  });

  it("supports token rotation — latest registration wins", () => {
    const r = createRedactor({ seedDefaults: false });
    r.registerTokenValue(GHP_TOKEN);
    r.registerTokenValue("replacement_TOKEN_1234567890");
    const out = r.redactString("text replacement_TOKEN more");
    expect(out).not.toContain("replacement_TOKEN");
  });
});

describe("redactor — default credential-shape patterns (task 3.2)", () => {
  const cases: Array<readonly [string, string]> = [
    ["ghp_ (classic PAT)", "use ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 now"],
    ["gho_ (OAuth token)", "bearer gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 here"],
    ["github_pat_ (fine-grained)", "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["AKIA (AWS access key)", "aws key AKIAIOSFODNN7EXAMPLE rotated"],
    ["AIza (Google API)", "key=AIzaSyA-1234567890abcdefghijklmnopqrstu "],
    ["sk_live_ (Stripe live)", "charge via sk_live_abcdefghijklmnopqrstuvwx"],
    ["sk_test_ (Stripe test)", "ok sk_test_abcdefghijklmnopqrstuvwx"],
    ["xoxb- (Slack token)", "slack xoxb-1234567890-ABCDEFGHIJ done"],
    ["PEM private-key header", "config:\n-----BEGIN RSA PRIVATE KEY-----\nMIIE..."],
  ];

  for (const [label, text] of cases) {
    it(`masks ${label}`, () => {
      const r = createRedactor();
      const out = r.redactString(text);
      expect(out).toContain("[REDACTED");
      expect(out).not.toEqual(text);
    });
  }
});

describe("redactor — registerPattern (task 3.2)", () => {
  it("adds a user-supplied pattern that is then applied by redactString", () => {
    const r = createRedactor({ seedDefaults: false });
    r.registerPattern({
      id: "internal-token",
      pattern: /INT_[A-Z0-9]{8,}/g,
      replacement: "[REDACTED:internal]",
    });
    const out = r.redactString("use INT_ABCD1234 for lookup");
    expect(out).toContain("[REDACTED:internal]");
    expect(out).not.toContain("INT_ABCD1234");
  });

  it("normalizes non-global patterns to replace every occurrence", () => {
    const r = createRedactor({ seedDefaults: false });
    r.registerPattern({
      id: "xyz",
      pattern: /XYZ[0-9]+/,
      replacement: "[X]",
    });
    const out = r.redactString("XYZ1 and XYZ2 and XYZ3");
    expect(out).toBe("[X] and [X] and [X]");
  });
});

describe("redactor — redactPayload (task 3.2)", () => {
  it("redacts string leaves in nested objects and arrays", () => {
    const r = createRedactor();
    r.registerTokenValue(GHP_TOKEN);
    const input = {
      level: "info",
      message: `auth with ${GHP_TOKEN}`,
      meta: {
        tokens: [GHP_TOKEN, "unrelated"],
        inner: { note: "nothing sensitive" },
      },
      count: 42,
      active: true,
      missing: null,
    };
    const out = r.redactPayload(input);
    expect(out.message).not.toContain(GHP_TOKEN);
    expect(out.message).toContain("[REDACTED");
    expect(out.meta.tokens[0]).not.toContain(GHP_TOKEN);
    expect(out.meta.tokens[1]).toBe("unrelated");
    expect(out.meta.inner.note).toBe("nothing sensitive");
    expect(out.count).toBe(42);
    expect(out.active).toBe(true);
    expect(out.missing).toBeNull();
  });

  it("does not mutate the input object", () => {
    const r = createRedactor();
    r.registerTokenValue(GHP_TOKEN);
    const input = { token: GHP_TOKEN, nested: { a: GHP_TOKEN } };
    r.redactPayload(input);
    expect(input.token).toBe(GHP_TOKEN);
    expect(input.nested.a).toBe(GHP_TOKEN);
  });

  it("returns a deep clone (mutating output does not affect input)", () => {
    const r = createRedactor({ seedDefaults: false });
    const input = { list: [{ value: "x" }] };
    const out = r.redactPayload(input);
    out.list[0]!.value = "MUTATED";
    expect(input.list[0]!.value).toBe("x");
  });

  it("passes primitive root values through redactString semantics", () => {
    const r = createRedactor();
    r.registerTokenValue(GHP_TOKEN);
    expect(r.redactPayload(42)).toBe(42);
    expect(r.redactPayload(true)).toBe(true);
    expect(r.redactPayload(null)).toBeNull();
    const outStr = r.redactPayload(`contains ${GHP_TOKEN}`);
    expect(outStr).not.toContain(GHP_TOKEN);
  });

  it("applies the full rule set (token + patterns) to every string", () => {
    const r = createRedactor();
    r.registerTokenValue(GHP_TOKEN);
    const input = {
      logline: `${GHP_TOKEN} and AKIAIOSFODNN7EXAMPLE same payload`,
    };
    const out = r.redactPayload(input);
    expect(out.logline).not.toContain(GHP_TOKEN);
    expect(out.logline).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});
