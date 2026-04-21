// Task 7.5 (ConflictResolver) will extend this with file-change details.
// Kept minimal here so DomainError.E_CONFLICT can typecheck before the
// resolver lands.
export type ConflictReport = {
  readonly classification: "diverged";
  readonly local: { readonly hash: string | null };
  readonly remote: { readonly revision: string | null };
  readonly lastKnown: {
    readonly localHash: string | null;
    readonly remoteRevision: string | null;
  };
};
