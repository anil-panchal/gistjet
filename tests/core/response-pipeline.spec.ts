import { describe, expect, it } from "vitest";

import { createRedactor } from "../../src/core/redactor";
import { redactResponse, wrapHandler } from "../../src/core/response-pipeline";

const GHP_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

describe("redactResponse (task 3.3)", () => {
  it("returns a deep-cloned value with registered tokens masked", () => {
    const redactor = createRedactor({ seedDefaults: false });
    redactor.registerTokenValue(GHP_TOKEN);
    const input = { message: `hello ${GHP_TOKEN}` };
    const out = redactResponse(redactor, input);
    expect(out.message).not.toContain("ghp_");
    expect(out.message).toContain("[REDACTED");
    // Input is not mutated.
    expect(input.message).toContain("ghp_");
  });

  it("applies default credential patterns without an explicit token", () => {
    const redactor = createRedactor();
    const out = redactResponse(redactor, { key: "AKIAIOSFODNN7EXAMPLE" });
    expect(out.key).not.toContain("AKIA");
  });

  it("passes non-string primitives through unchanged", () => {
    const redactor = createRedactor();
    expect(redactResponse(redactor, 42)).toBe(42);
    expect(redactResponse(redactor, true)).toBe(true);
    expect(redactResponse(redactor, null)).toBeNull();
  });
});

describe("wrapHandler (task 3.3)", () => {
  it("passes arguments through to the inner handler", async () => {
    const redactor = createRedactor();
    const received: unknown[] = [];
    const inner = async (a: number, b: string): Promise<{ echo: string }> => {
      received.push(a, b);
      return { echo: `${a}:${b}` };
    };
    const wrapped = wrapHandler(redactor, inner);
    await wrapped(7, "hi");
    expect(received).toEqual([7, "hi"]);
  });

  it("redacts the return value via redactor.redactPayload", async () => {
    const redactor = createRedactor({ seedDefaults: false });
    redactor.registerTokenValue(GHP_TOKEN);
    const inner = async (): Promise<{ token: string; safe: string }> => ({
      token: GHP_TOKEN,
      safe: "ok",
    });
    const wrapped = wrapHandler(redactor, inner);
    const out = await wrapped();
    expect(out.token).not.toContain("ghp_");
    expect(out.token).toContain("[REDACTED");
    expect(out.safe).toBe("ok");
  });

  it("does not swallow thrown errors from the inner handler", async () => {
    const redactor = createRedactor();
    const inner = async (): Promise<never> => {
      throw new Error("boom");
    };
    const wrapped = wrapHandler(redactor, inner);
    await expect(wrapped()).rejects.toThrow("boom");
  });
});
