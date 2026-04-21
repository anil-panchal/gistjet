import ignore, { type Ignore } from "ignore";

export type IgnoreSource = "builtin" | "workspace" | "gitignore";

export type IgnoreExplanation = {
  readonly source: IgnoreSource;
  readonly pattern: string;
};

export interface IgnoreMatcher {
  isIgnored(relativePath: string): boolean;
  explain(relativePath: string): IgnoreExplanation | null;
}

export type IgnoreConfig = {
  readonly workspaceRoot: string;
  readonly workspacePatterns: readonly string[];
  readonly respectGitignore: boolean;
  readonly gitignoreContents?: string;
};

export interface IgnoreEngine {
  build(config: IgnoreConfig): IgnoreMatcher;
}

export const HARDENED_IGNORE_PATTERNS: readonly string[] = [".env*", ".git/"];

const NON_HARDENED_BUILTIN_PATTERNS: readonly string[] = [
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".DS_Store",
  "*.log",
  "*.zip",
  "*.tar",
  "*.tar.gz",
  "*.tgz",
  "*.7z",
  "*.rar",
  "*.gz",
  "*.bz2",
  "*.xz",
  "*.jpg",
  "*.jpeg",
  "*.png",
  "*.gif",
  "*.ico",
  "*.pdf",
  "*.exe",
  "*.dll",
  "*.so",
  "*.dylib",
  "*.class",
  "*.jar",
  "*.war",
  "*.o",
  "*.a",
];

export const BUILTIN_IGNORE_PATTERNS: readonly string[] = [
  ...HARDENED_IGNORE_PATTERNS,
  ...NON_HARDENED_BUILTIN_PATTERNS,
];

function parseGitignoreContents(contents: string | undefined): readonly string[] {
  if (!contents) return [];
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function singlePatternMatches(pattern: string, path: string): boolean {
  if (pattern.startsWith("!")) return false;
  const matcher: Ignore = ignore().add(pattern);
  return matcher.ignores(path);
}

export function createIgnoreEngine(): IgnoreEngine {
  function build(config: IgnoreConfig): IgnoreMatcher {
    const workspacePatterns = [...config.workspacePatterns];
    const gitignorePatterns = config.respectGitignore
      ? parseGitignoreContents(config.gitignoreContents)
      : [];

    // Aggregate matcher: order matters. `ignore` uses "last match wins"; by placing
    // HARDENED_IGNORE_PATTERNS last we guarantee workspace or gitignore negations
    // cannot un-ignore `.env*` or `.git/`.
    const aggregate: Ignore = ignore().add([
      ...NON_HARDENED_BUILTIN_PATTERNS,
      ...workspacePatterns,
      ...gitignorePatterns,
      ...HARDENED_IGNORE_PATTERNS,
    ]);

    function isIgnored(relativePath: string): boolean {
      return aggregate.ignores(relativePath);
    }

    function explain(relativePath: string): IgnoreExplanation | null {
      if (!aggregate.ignores(relativePath)) return null;
      for (const pattern of HARDENED_IGNORE_PATTERNS) {
        if (singlePatternMatches(pattern, relativePath)) {
          return { source: "builtin", pattern };
        }
      }
      for (const pattern of workspacePatterns) {
        if (singlePatternMatches(pattern, relativePath)) {
          return { source: "workspace", pattern };
        }
      }
      for (const pattern of NON_HARDENED_BUILTIN_PATTERNS) {
        if (singlePatternMatches(pattern, relativePath)) {
          return { source: "builtin", pattern };
        }
      }
      for (const pattern of gitignorePatterns) {
        if (singlePatternMatches(pattern, relativePath)) {
          return { source: "gitignore", pattern };
        }
      }
      return null;
    }

    return { isIgnored, explain };
  }

  return { build };
}
