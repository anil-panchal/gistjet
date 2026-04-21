export type GistFileRef = {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly isBinary: boolean;
  readonly truncated: boolean;
  readonly rawUrl: string | null;
};

export type GistMeta = {
  readonly gistId: string;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly public: boolean;
  readonly updatedAt: string;
  readonly revision: string;
  readonly files: readonly GistFileRef[];
};

export type GistFull = Omit<GistMeta, "files"> & {
  readonly files: ReadonlyArray<GistFileRef & { readonly content: string | null }>;
};

export type GistSummary = {
  readonly gistId: string;
  readonly htmlUrl: string;
  readonly description: string | null;
  readonly public: boolean;
  readonly updatedAt: string;
  readonly filenames: readonly string[];
};

export type GistAccessProbe = {
  readonly login: string;
  readonly scopesHeader: string | null;
};
