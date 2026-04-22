import { describe, expect, it } from "vitest";

import { formatHelp, formatTtyBanner, formatVersion } from "../../src/bin/cli-messages.js";

describe("formatVersion", () => {
  it("contains the version string", () => {
    expect(formatVersion("1.0.0")).toContain("1.0.0");
  });

  it("ends with a newline", () => {
    expect(formatVersion("1.0.0").endsWith("\n")).toBe(true);
  });
});

describe("formatHelp", () => {
  it("contains GISTJET_GITHUB_TOKEN", () => {
    expect(formatHelp("1.0.0")).toContain("GISTJET_GITHUB_TOKEN");
  });

  it("contains GITHUB_TOKEN", () => {
    expect(formatHelp("1.0.0")).toContain("GITHUB_TOKEN");
  });

  it("contains GISTJET_WORKSPACE_ROOT", () => {
    expect(formatHelp("1.0.0")).toContain("GISTJET_WORKSPACE_ROOT");
  });

  it("references Claude Desktop", () => {
    expect(formatHelp("1.0.0")).toMatch(/[Cc]laude\s+[Dd]esktop/);
  });

  it("references Claude Code", () => {
    expect(formatHelp("1.0.0")).toMatch(/[Cc]laude\s+[Cc]ode/);
  });

  it("references Cursor", () => {
    expect(formatHelp("1.0.0")).toContain("Cursor");
  });

  it("includes the -- separator in the Claude Code example", () => {
    expect(formatHelp("1.0.0")).toContain("--");
  });

  it("contains a read-only mode note", () => {
    const output = formatHelp("1.0.0");
    expect(output).toMatch(/read.only/i);
  });

  it("contains the version string", () => {
    expect(formatHelp("1.0.0")).toContain("1.0.0");
  });

  it("ends with a newline", () => {
    expect(formatHelp("1.0.0").endsWith("\n")).toBe(true);
  });
});

describe("formatTtyBanner", () => {
  it("contains a reference to --help", () => {
    expect(formatTtyBanner("1.0.0")).toContain("--help");
  });

  it("ends with a newline", () => {
    expect(formatTtyBanner("1.0.0").endsWith("\n")).toBe(true);
  });
});
