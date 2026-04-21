import { err, ok, type Result } from "../shared/result";

export type Visibility = "secret" | "public";

export type VisibilityInput = {
  readonly requested?: Visibility;
  readonly confirmPublic?: boolean;
};

export type VisibilityError = { readonly code: "E_VISIBILITY_CONFIRM" };

export interface VisibilityGuard {
  decide(input: VisibilityInput): Result<Visibility, VisibilityError>;
}

export function createVisibilityGuard(): VisibilityGuard {
  function decide(input: VisibilityInput): Result<Visibility, VisibilityError> {
    if (input.requested === "public") {
      if (input.confirmPublic === true) return ok("public");
      return err({ code: "E_VISIBILITY_CONFIRM" });
    }
    return ok("secret");
  }
  return { decide };
}
