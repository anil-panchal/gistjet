import { describe, expect, it } from "vitest";

import type { Result } from "../../src/shared/result";
import { err, isErr, isOk, ok } from "../../src/shared/result";

describe("Result envelope (task 2.1)", () => {
  it("ok() produces a success variant carrying the value", () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(42);
    }
  });

  it("err() produces an error variant carrying the error", () => {
    const r = err({ code: "E_INPUT" as const, message: "bad input" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("E_INPUT");
    }
  });

  it("isOk narrows to the success variant", () => {
    const r: Result<number, string> = ok(7);
    if (isOk(r)) {
      // Inside this branch, r.value is statically `number`.
      const v: number = r.value;
      expect(v).toBe(7);
    } else {
      throw new Error("expected ok");
    }
  });

  it("isErr narrows to the error variant", () => {
    const r: Result<number, string> = err("boom");
    if (isErr(r)) {
      const msg: string = r.error;
      expect(msg).toBe("boom");
    } else {
      throw new Error("expected err");
    }
  });

  it("ok and err are structurally disjoint", () => {
    const a: Result<number, string> = ok(1);
    const b: Result<number, string> = err("x");
    expect(a.ok).not.toBe(b.ok);
  });
});
