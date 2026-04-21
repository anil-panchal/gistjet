import { describe, expect, it } from "vitest";

import { createVisibilityGuard } from "../../src/core/visibility-guard";
import { isErr, isOk } from "../../src/shared/result";

describe("VisibilityGuard.decide (task 7.4, req 9.1, 9.2, 9.3)", () => {
  it("defaults to 'secret' when visibility is not supplied", () => {
    const guard = createVisibilityGuard();
    const result = guard.decide({});
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toBe("secret");
  });

  it("honors an explicit 'secret' request regardless of confirm_public", () => {
    const guard = createVisibilityGuard();
    const a = guard.decide({ requested: "secret" });
    const b = guard.decide({ requested: "secret", confirmPublic: true });
    expect(isOk(a) && a.value).toBe("secret");
    expect(isOk(b) && b.value).toBe("secret");
  });

  it("allows 'public' only when confirmPublic is explicitly true", () => {
    const guard = createVisibilityGuard();
    const result = guard.decide({ requested: "public", confirmPublic: true });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toBe("public");
  });

  it("rejects unconfirmed public with E_VISIBILITY_CONFIRM", () => {
    const guard = createVisibilityGuard();
    const result = guard.decide({ requested: "public" });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("E_VISIBILITY_CONFIRM");
  });

  it("rejects public with confirmPublic explicitly false", () => {
    const guard = createVisibilityGuard();
    const result = guard.decide({ requested: "public", confirmPublic: false });
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.code).toBe("E_VISIBILITY_CONFIRM");
  });

  it("is a pure function — two calls with the same input return equal decisions", () => {
    const guard = createVisibilityGuard();
    const a = guard.decide({ requested: "public", confirmPublic: true });
    const b = guard.decide({ requested: "public", confirmPublic: true });
    expect(a).toEqual(b);
  });
});
