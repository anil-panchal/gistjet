import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { createRedactor } from "../../src/core/redactor";

const TOKEN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";

const tokenArb = fc.stringOf(fc.constantFrom(...TOKEN_CHARS.split("")), {
  minLength: 10,
  maxLength: 40,
});

function nestAtDepth(leaf: unknown, depth: number): unknown {
  let payload = leaf;
  for (let i = 0; i < depth; i += 1) {
    payload = i % 2 === 0 ? { nested: payload } : [payload];
  }
  return payload;
}

describe("redactor property: token substrings ≥10 chars are always masked (task 3.4)", () => {
  it("redactPayload masks any random-position ≥10-char substring at arbitrary depth", () => {
    fc.assert(
      fc.property(
        tokenArb,
        fc.nat({ max: 40 }),
        fc.nat({ max: 40 }),
        fc.integer({ min: 0, max: 6 }),
        fc.string({ maxLength: 16 }),
        fc.string({ maxLength: 16 }),
        (token, startSeed, lenSeed, depth, prefix, suffix) => {
          const start = startSeed % token.length;
          const remaining = token.length - start;
          fc.pre(remaining >= 10);
          const len = 10 + (lenSeed % (remaining - 9));
          const substring = token.slice(start, start + len);

          const redactor = createRedactor({ seedDefaults: false });
          redactor.registerTokenValue(token);

          const payload = nestAtDepth({ text: `${prefix}${substring}${suffix}` }, depth);
          const redacted = redactor.redactPayload(payload);
          const serialized = JSON.stringify(redacted);

          expect(serialized).not.toContain(substring);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("does not over-redact shorter-than-10 substrings of the token", () => {
    fc.assert(
      fc.property(
        tokenArb,
        fc.nat({ max: 40 }),
        fc.nat({ max: 9 }),
        (token, startSeed, lenSeed) => {
          const start = startSeed % token.length;
          const remaining = token.length - start;
          const len = Math.min(remaining, lenSeed + 1);
          fc.pre(len < 10);
          const shortSub = token.slice(start, start + len);
          // Pad with non-token chars so the short substring can't concatenate with
          // adjacent token-substring characters and grow past 9.
          const boundary = "! @ !";
          const text = `${boundary}${shortSub}${boundary}`;

          const redactor = createRedactor({ seedDefaults: false });
          redactor.registerTokenValue(token);
          const out = redactor.redactString(text);

          expect(out).toContain(shortSub);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("redactor — every default credential pattern survives nesting (task 3.4)", () => {
  const credentials: ReadonlyArray<readonly [string, string]> = [
    ["github-pat-classic", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["github-oauth", "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["github-pat-fine-grained", "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
    ["aws-access-key", "AKIAIOSFODNN7EXAMPLE"],
    ["google-api-key", "AIzaSyA-1234567890abcdefghijklmnopqrstu"],
    ["stripe-live", "sk_live_abcdefghijklmnopqrstuvwx"],
    ["stripe-test", "sk_test_abcdefghijklmnopqrstuvwx"],
    ["slack-token", "xoxb-1234567890-ABCDEFGHIJ"],
    ["pem-private-key-header", "-----BEGIN RSA PRIVATE KEY-----"],
  ];

  it.each(credentials)(
    "redactPayload masks %s inside deeply nested arrays + objects",
    (_label, credential) => {
      const redactor = createRedactor();
      const payload = {
        logs: [
          {
            event: "leak",
            meta: {
              detail: credential,
              context: { trace: [{ line: credential, ok: false }] },
            },
          },
        ],
      };
      const out = redactor.redactPayload(payload);
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain(credential);
      expect(serialized).toContain("[REDACTED");
    },
  );

  it("redactPayload masks multiple distinct credential shapes in one payload", () => {
    const redactor = createRedactor();
    const payload = {
      a: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      nested: {
        b: "AKIAIOSFODNN7EXAMPLE",
        arr: ["sk_live_abcdefghijklmnopqrstuvwx", "AIzaSyA-1234567890abcdefghijklmnopqrstu"],
      },
    };
    const serialized = JSON.stringify(redactor.redactPayload(payload));
    for (const cred of [
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      "AKIAIOSFODNN7EXAMPLE",
      "sk_live_abcdefghijklmnopqrstuvwx",
      "AIzaSyA-1234567890abcdefghijklmnopqrstu",
    ]) {
      expect(serialized).not.toContain(cred);
    }
  });
});
