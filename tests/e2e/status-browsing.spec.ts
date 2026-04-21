import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { callError, callStructured, makeE2EHarness, type E2EHarness } from "./harness";

type PublishResponse = {
  gist_id: string;
  mapping: { id: string; local_path: string };
};

async function publishFile(
  harness: E2EHarness,
  filename: string,
  content: string,
): Promise<PublishResponse> {
  const file = path.join(harness.workspaceRoot, filename);
  await fsp.writeFile(file, content, "utf8");
  const res = await harness.client.callTool({
    name: "publish_path_to_gist",
    arguments: { path: file },
  });
  expect(res.isError).toBeFalsy();
  return callStructured<PublishResponse>(res);
}

async function getStatus(harness: E2EHarness, mappingId: string): Promise<string> {
  const res = await harness.client.callTool({
    name: "sync_status",
    arguments: { mapping_id: mappingId },
  });
  expect(res.isError).toBeFalsy();
  const sc = callStructured<{
    entries: ReadonlyArray<{ mapping_id: string; classification: string }>;
  }>(res);
  const entry = sc.entries.find((e) => e.mapping_id === mappingId);
  expect(entry).toBeDefined();
  return entry!.classification;
}

describe("E2E status and browsing (task 10.3, req 4.1/4.6, 5.1/5.2/5.3, 11.3)", () => {
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

  it("classifies a just-published mapping as in_sync", async () => {
    const pub = await publishFile(harness, "a.md", "hello\n");
    expect(await getStatus(harness, pub.mapping.id)).toBe("in_sync");
  });

  it("classifies a locally-edited mapping as local_ahead", async () => {
    const pub = await publishFile(harness, "a.md", "hello\n");
    await fsp.writeFile(path.join(harness.workspaceRoot, "a.md"), "changed\n", "utf8");
    expect(await getStatus(harness, pub.mapping.id)).toBe("local_ahead");
  });

  it("classifies a remote-advanced mapping as remote_ahead", async () => {
    const pub = await publishFile(harness, "a.md", "hello\n");
    const gist = harness.gistStore.gists.get(pub.gist_id)!;
    gist.files["a.md"] = { content: "remote-change\n" };
    gist.revision = `${gist.revision}-advanced`;
    expect(await getStatus(harness, pub.mapping.id)).toBe("remote_ahead");
  });

  it("classifies a mapping whose local and remote have both changed as diverged", async () => {
    const pub = await publishFile(harness, "a.md", "hello\n");
    await fsp.writeFile(path.join(harness.workspaceRoot, "a.md"), "local-new\n", "utf8");
    const gist = harness.gistStore.gists.get(pub.gist_id)!;
    gist.files["a.md"] = { content: "remote-new\n" };
    gist.revision = `${gist.revision}-advanced`;
    expect(await getStatus(harness, pub.mapping.id)).toBe("diverged");
  });

  it("classifies a mapping whose remote has been deleted as orphaned", async () => {
    const pub = await publishFile(harness, "a.md", "hello\n");
    harness.gistStore.gists.delete(pub.gist_id);
    expect(await getStatus(harness, pub.mapping.id)).toBe("orphaned");
  });

  it("classifies a mapping whose local file has been deleted as local_missing", async () => {
    const pub = await publishFile(harness, "a.md", "hello\n");
    await fsp.rm(path.join(harness.workspaceRoot, "a.md"));
    expect(await getStatus(harness, pub.mapping.id)).toBe("local_missing");
  });

  it("aggregates statuses across multiple mappings via sync_status without mapping_id", async () => {
    const p1 = await publishFile(harness, "a.md", "hello-a\n");
    const p2 = await publishFile(harness, "b.md", "hello-b\n");
    await fsp.writeFile(path.join(harness.workspaceRoot, "a.md"), "edited\n", "utf8");

    const res = await harness.client.callTool({ name: "sync_status", arguments: {} });
    const sc = callStructured<{
      entries: ReadonlyArray<{ mapping_id: string; classification: string }>;
    }>(res);
    const map = new Map(sc.entries.map((e) => [e.mapping_id, e.classification]));
    expect(map.get(p1.mapping.id)).toBe("local_ahead");
    expect(map.get(p2.mapping.id)).toBe("in_sync");
  });

  it("filters list_gists by visibility and by query substring", async () => {
    // Seed the fake store directly so we exercise list filters without
    // going through publish (which only creates secret gists by default).
    harness.gistStore.add({
      id: "pub-1",
      description: "public snippet",
      public: true,
      updatedAt: new Date().toISOString(),
      revision: "rev-pub",
      files: { "hello.md": { content: "hi\n" } },
    });
    harness.gistStore.add({
      id: "sec-1",
      description: "my secret thoughts",
      public: false,
      updatedAt: new Date().toISOString(),
      revision: "rev-sec",
      files: { "journal.md": { content: "shh\n" } },
    });

    const pubOnly = await harness.client.callTool({
      name: "list_gists",
      arguments: { filter: { visibility: "public" } },
    });
    const pubSc = callStructured<{
      items: ReadonlyArray<{ gist_id: string; public: boolean }>;
    }>(pubOnly);
    expect(pubSc.items.every((i) => i.public === true)).toBe(true);
    expect(pubSc.items.some((i) => i.gist_id === "pub-1")).toBe(true);
    expect(pubSc.items.some((i) => i.gist_id === "sec-1")).toBe(false);

    const queried = await harness.client.callTool({
      name: "list_gists",
      arguments: { filter: { query: "journal" } },
    });
    const qSc = callStructured<{ items: ReadonlyArray<{ gist_id: string }> }>(queried);
    expect(qSc.items.map((i) => i.gist_id)).toEqual(["sec-1"]);
  });

  it("open_gist falls back to raw_url when the API returns truncated: true", async () => {
    const bigContent = "x".repeat(2_000_000);
    const filename = "big.md";
    harness.gistStore.add({
      id: "trunc-1",
      description: null,
      public: false,
      updatedAt: new Date().toISOString(),
      revision: "rev-trunc",
      files: {
        [filename]: {
          content: bigContent,
          truncated: true,
          rawUrl: `https://gist.githubusercontent.com/raw/${filename}`,
          size: bigContent.length,
        },
      },
    });
    harness.gistStore.rawOverrides.set(`raw:${filename}`, {
      url: `https://gist.githubusercontent.com/raw/${filename}`,
      body: bigContent,
      headers: { "content-type": "text/plain" },
    });

    const res = await harness.client.callTool({
      name: "open_gist",
      arguments: { gist_id: "trunc-1" },
    });
    expect(res.isError).toBeFalsy();
    const sc = callStructured<{
      files: ReadonlyArray<{ filename: string; content: string | null; truncated: boolean }>;
    }>(res);
    const f = sc.files.find((fi) => fi.filename === filename);
    expect(f).toBeDefined();
    expect(f!.content).toBe(bigContent);
    // truncated flag carries through from the gist view adapter.
    expect(f!.truncated).toBe(true);
  });

  it("open_gist returns E_NOT_FOUND for a missing gist id", async () => {
    const res = await harness.client.callTool({
      name: "open_gist",
      arguments: { gist_id: "does-not-exist" },
    });
    expect(res.isError).toBe(true);
    const sc = callError<{ code: string }>(res);
    expect(sc.code).toBe("E_NOT_FOUND");
  });
});
