import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { callError, callStructured, makeE2EHarness, type E2EHarness } from "./harness";

describe("E2E publish flow (task 10.1, req 2.1/2.2/2.4/2.7/2.8, 8.2, 9.2, 10.1/10.5, 11.1/11.2/11.4)", () => {
  let harness: E2EHarness;

  beforeEach(async () => {
    harness = await makeE2EHarness();
    await harness.client.callTool({
      name: "init_workspace",
      arguments: { target_dir: harness.workspaceRoot },
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("publishes a single file and persists a mapping that appears in list_gists as is_mapped", async () => {
    const file = path.join(harness.workspaceRoot, "notes.md");
    await fsp.writeFile(file, "hello world\n", "utf8");

    const res = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file, description: "first gist" },
    });
    expect(res.isError).toBeFalsy();
    const pub = callStructured<{
      gist_id: string;
      visibility: string;
      warnings: readonly unknown[];
      mapping: { id: string; kind: string; visibility: string };
      ignored_files: readonly string[];
    }>(res);
    expect(pub.visibility).toBe("secret");
    expect(pub.mapping.kind).toBe("file");
    expect(pub.warnings).toEqual([]);
    expect(pub.ignored_files).toEqual([]);
    expect(harness.gistStore.gists.has(pub.gist_id)).toBe(true);

    const list = await harness.client.callTool({ name: "list_gists", arguments: {} });
    const listed = callStructured<{
      items: ReadonlyArray<{ gist_id: string; is_mapped: boolean }>;
    }>(list);
    const entry = listed.items.find((i) => i.gist_id === pub.gist_id);
    expect(entry?.is_mapped).toBe(true);
  });

  it("publishes a folder: hardened-ignore patterns drop .env and .git/ even when listed", async () => {
    const folder = path.join(harness.workspaceRoot, "docs");
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, "readme.md"), "# hi\n", "utf8");
    await fsp.writeFile(path.join(folder, ".env"), "DB_PASS=hunter2\n", "utf8");
    await fsp.mkdir(path.join(folder, ".git"), { recursive: true });
    await fsp.writeFile(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    const res = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: folder },
    });
    expect(res.isError).toBeFalsy();
    const pub = callStructured<{
      gist_id: string;
      ignored_files: readonly string[];
      mapping: { kind: string };
    }>(res);
    expect(pub.mapping.kind).toBe("folder");
    expect(pub.ignored_files).toContain(".env");
    expect(pub.ignored_files.some((p) => p.startsWith(".git/"))).toBe(true);
    const remote = harness.gistStore.gists.get(pub.gist_id);
    expect(remote).toBeDefined();
    expect(Object.keys(remote!.files).sort()).toEqual(["readme.md"]);
  });

  it("publishes a folder with nested paths and flattens filenames deterministically", async () => {
    const folder = path.join(harness.workspaceRoot, "project");
    await fsp.mkdir(path.join(folder, "src", "core"), { recursive: true });
    await fsp.mkdir(path.join(folder, "src", "util"), { recursive: true });
    await fsp.writeFile(path.join(folder, "README.md"), "top\n", "utf8");
    await fsp.writeFile(path.join(folder, "src", "core", "a.ts"), "core-a\n", "utf8");
    await fsp.writeFile(path.join(folder, "src", "util", "b.ts"), "util-b\n", "utf8");

    const res = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: folder },
    });
    expect(res.isError).toBeFalsy();
    const pub = callStructured<{ gist_id: string }>(res);
    const remote = harness.gistStore.gists.get(pub.gist_id);
    expect(remote).toBeDefined();
    expect(Object.keys(remote!.files).sort()).toEqual([
      "README.md",
      "src__core__a.ts",
      "src__util__b.ts",
    ]);
  });

  it("publishes a selection via publish_selection_to_gist", async () => {
    const res = await harness.client.callTool({
      name: "publish_selection_to_gist",
      arguments: { filename: "scratch.md", content: "inline content\n" },
    });
    expect(res.isError).toBeFalsy();
    const pub = callStructured<{ gist_id: string; mapping: { local_path: string } }>(res);
    expect(pub.mapping.local_path).toBe("scratch.md");
    const remote = harness.gistStore.gists.get(pub.gist_id);
    expect(remote?.files["scratch.md"]?.content).toBe("inline content\n");
  });

  it("aborts publish with redacted findings when a high-confidence secret is present", async () => {
    const file = path.join(harness.workspaceRoot, "leaked.sh");
    const fake = `export AWS_KEY=AKIAIOSFODNN7EXAMPLE\n`;
    await fsp.writeFile(file, fake, "utf8");

    const res = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file },
    });
    expect(res.isError).toBe(true);
    const sc = callError<{
      code: string;
      details: { findings: ReadonlyArray<{ ruleId: string; redactedExcerpt: string }> };
    }>(res);
    expect(sc.code).toBe("E_SECRET_DETECTED");
    const findings = sc.details.findings;
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.ruleId).toBe("aws-access-key");
    // Excerpt must be redacted — the raw secret must not appear.
    expect(findings[0]?.redactedExcerpt).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // No gist was created.
    expect(harness.gistStore.gists.size).toBe(0);
  });

  it("rejects oversize files with E_TOO_LARGE and does not create a gist", async () => {
    const file = path.join(harness.workspaceRoot, "huge.txt");
    // Default perFileLimit is 1,000,000 bytes. Write just above it.
    const payload = "x".repeat(1_000_001);
    await fsp.writeFile(file, payload, "utf8");

    const res = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file },
    });
    expect(res.isError).toBe(true);
    const sc = callError<{ code: string; details: { sizeBytes: number; limit: number } }>(res);
    expect(sc.code).toBe("E_TOO_LARGE");
    expect(sc.details.sizeBytes).toBeGreaterThan(sc.details.limit);
    expect(harness.gistStore.gists.size).toBe(0);
  });

  it("refuses binary files by default and accepts them when allow_binary=true", async () => {
    const file = path.join(harness.workspaceRoot, "blob.png");
    await fsp.writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));

    const refused = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file },
    });
    expect(refused.isError).toBe(true);
    expect(callError<{ code: string }>(refused).code).toBe("E_BINARY");

    const allowed = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file, allow_binary: true },
    });
    expect(allowed.isError).toBeFalsy();
    const pub = callStructured<{ gist_id: string }>(allowed);
    expect(harness.gistStore.gists.has(pub.gist_id)).toBe(true);
  });

  it("flattens sibling paths deterministically without spurious collisions", async () => {
    // Real filesystem paths cannot produce an `E_FILENAME_COLLISION` from
    // the current flattener because underscore and other non-safe chars get
    // percent-encoded (`a__b.ts` → `a%5F%5Fb.ts`, distinct from `a/b.ts` →
    // `a__b.ts`). The collision abort branch is exercised at the unit level
    // (`tests/core/filename-flattener.spec.ts`); here we confirm the happy
    // path produces the expected deterministic names.
    const folder = path.join(harness.workspaceRoot, "twins");
    await fsp.mkdir(path.join(folder, "a"), { recursive: true });
    await fsp.writeFile(path.join(folder, "a", "b.ts"), "A\n", "utf8");
    await fsp.writeFile(path.join(folder, "a__b.ts"), "B\n", "utf8");

    const res = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: folder },
    });
    expect(res.isError).toBeFalsy();
    const pub = callStructured<{ gist_id: string }>(res);
    const remote = harness.gistStore.gists.get(pub.gist_id);
    expect(remote).toBeDefined();
    expect(Object.keys(remote!.files).sort()).toEqual(["a%5F%5Fb.ts", "a__b.ts"]);
  });

  it("returns E_POST_PUBLISH_MISMATCH when remote content differs from what we sent (no mapping persisted)", async () => {
    const file = path.join(harness.workspaceRoot, "payload.md");
    await fsp.writeFile(file, "intended content\n", "utf8");

    // Tamper the create path so remote stores altered content — the post-publish
    // verify step must detect the mismatch and refuse to persist a mapping.
    harness.gistStore.tamperNextCreate((files) =>
      Object.fromEntries(
        Object.entries(files).map(([name, data]) => [name, { ...data, content: "ALTERED\n" }]),
      ),
    );

    const res = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file },
    });
    expect(res.isError).toBe(true);
    const sc = callError<{
      code: string;
      details: { gistId: string; mismatched: readonly string[] };
    }>(res);
    expect(sc.code).toBe("E_POST_PUBLISH_MISMATCH");
    expect(sc.details.mismatched).toContain("payload.md");
    // The gist exists on the remote (discoverable for manual cleanup) but
    // no mapping is recorded — a fresh `sync_status` sees no entries.
    expect(harness.gistStore.gists.has(sc.details.gistId)).toBe(true);
    const status = await harness.client.callTool({ name: "sync_status", arguments: {} });
    const statusSc = callStructured<{ entries: readonly unknown[] }>(status);
    expect(statusSc.entries).toEqual([]);
  });
});
