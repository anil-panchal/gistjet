import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../../src/bin/cli-args.js";

const argv = (flags: string[]): string[] => ["node", "gistjet.js", ...flags];

describe("parseCliArgs — version flag", () => {
  it("returns version for --version", () => {
    expect(parseCliArgs(argv(["--version"]), false)).toEqual({ kind: "version" });
  });

  it("returns version for -v", () => {
    expect(parseCliArgs(argv(["-v"]), false)).toEqual({ kind: "version" });
  });

  it("--version takes priority over other flags", () => {
    expect(parseCliArgs(argv(["--version", "--help"]), false)).toEqual({ kind: "version" });
    expect(parseCliArgs(argv(["--help", "--version"]), false)).toEqual({ kind: "version" });
  });

  it("--version works even when isTTY is true", () => {
    expect(parseCliArgs(argv(["--version"]), true)).toEqual({ kind: "version" });
  });
});

describe("parseCliArgs — help flag", () => {
  it("returns help for --help", () => {
    expect(parseCliArgs(argv(["--help"]), false)).toEqual({ kind: "help" });
  });

  it("returns help for -h", () => {
    expect(parseCliArgs(argv(["-h"]), false)).toEqual({ kind: "help" });
  });

  it("--help works even when isTTY is true", () => {
    expect(parseCliArgs(argv(["--help"]), true)).toEqual({ kind: "help" });
  });
});

describe("parseCliArgs — tty-banner", () => {
  it("returns tty-banner when no flags and isTTY is true", () => {
    expect(parseCliArgs(argv([]), true)).toEqual({ kind: "tty-banner" });
  });

  it("does not return tty-banner when isTTY is false", () => {
    expect(parseCliArgs(argv([]), false)).toEqual({ kind: "serve" });
  });

  it("does not return tty-banner when isTTY is undefined", () => {
    expect(parseCliArgs(argv([]), undefined)).toEqual({ kind: "serve" });
  });
});

describe("parseCliArgs — serve fallthrough", () => {
  it("returns serve when no flags and not a TTY", () => {
    expect(parseCliArgs(argv([]), false)).toEqual({ kind: "serve" });
  });

  it("returns serve for unrecognised flags when not a TTY", () => {
    expect(parseCliArgs(argv(["--foo"]), false)).toEqual({ kind: "serve" });
  });
});
