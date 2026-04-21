import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { callError, callStructured, makeE2EHarness, type E2EHarness } from "./harness";

type PublishResponse = {
  gist_id: string;
  visibility: string;
  warnings: ReadonlyArray<{ kind: string; message: string }>;
  mapping: { id: string; visibility: string };
};

describe("E2E safety and visibility (task 10.4, req 6.3, 9.2/9.3/9.4)", () => {
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

  it("publish with visibility=public and no confirm_public returns E_VISIBILITY_CONFIRM", async () => {
    const file = path.join(harness.workspaceRoot, "open.md");
    await fsp.writeFile(file, "hello world\n", "utf8");
    const res = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file, visibility: "public" },
    });
    expect(res.isError).toBe(true);
    const sc = callError<{ code: string }>(res);
    expect(sc.code).toBe("E_VISIBILITY_CONFIRM");
    // Nothing persisted.
    expect(harness.gistStore.gists.size).toBe(0);
  });

  it("publish with visibility=public and confirm_public=true succeeds and attaches a public_publish warning", async () => {
    const file = path.join(harness.workspaceRoot, "open.md");
    await fsp.writeFile(file, "hello world\n", "utf8");
    const res = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file, visibility: "public", confirm_public: true },
    });
    expect(res.isError).toBeFalsy();
    const pub = callStructured<PublishResponse>(res);
    expect(pub.visibility).toBe("public");
    expect(pub.mapping.visibility).toBe("public");
    expect(pub.warnings.some((w) => w.kind === "public_publish")).toBe(true);
    const remote = harness.gistStore.gists.get(pub.gist_id);
    expect(remote?.public).toBe(true);
  });

  it("sync refuses with E_VISIBILITY_CHANGE_REFUSED when remote visibility no longer matches the mapping", async () => {
    const file = path.join(harness.workspaceRoot, "notes.md");
    await fsp.writeFile(file, "hello\n", "utf8");
    const pubRes = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file },
    });
    expect(pubRes.isError).toBeFalsy();
    const pub = callStructured<PublishResponse>(pubRes);
    expect(pub.mapping.visibility).toBe("secret");

    // Flip remote visibility to public — the sync must refuse instead of silently
    // changing the mapping.
    const gist = harness.gistStore.gists.get(pub.gist_id)!;
    gist.public = true;

    const syncRes = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: pub.mapping.id },
    });
    expect(syncRes.isError).toBe(true);
    const sc = callError<{ code: string }>(syncRes);
    expect(sc.code).toBe("E_VISIBILITY_CHANGE_REFUSED");
  });

  it("unlink with delete_remote_gist=true but missing confirm_delete returns E_INPUT and preserves the gist", async () => {
    const file = path.join(harness.workspaceRoot, "notes.md");
    await fsp.writeFile(file, "hello\n", "utf8");
    const pubRes = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file },
    });
    const pub = callStructured<PublishResponse>(pubRes);

    const unlinkRes = await harness.client.callTool({
      name: "unlink_mapping",
      arguments: { mapping_id: pub.mapping.id, delete_remote_gist: true },
    });
    expect(unlinkRes.isError).toBe(true);
    const sc = callError<{ code: string; message: string }>(unlinkRes);
    expect(sc.code).toBe("E_INPUT");
    expect(sc.message).toMatch(/confirm_delete/);

    // Gist still exists remotely; mapping still present in workspace.
    expect(harness.gistStore.gists.has(pub.gist_id)).toBe(true);
    const mappingsRes = await harness.client.readResource({ uri: "gistjet://mappings" });
    const payload = JSON.parse((mappingsRes.contents[0] as { text: string }).text) as {
      mappings: ReadonlyArray<{ id: string }>;
    };
    expect(payload.mappings.some((m) => m.id === pub.mapping.id)).toBe(true);
  });

  it("unlink with delete_remote_gist=true and confirm_delete=true removes the mapping and the remote gist", async () => {
    const file = path.join(harness.workspaceRoot, "notes.md");
    await fsp.writeFile(file, "hello\n", "utf8");
    const pubRes = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file },
    });
    const pub = callStructured<PublishResponse>(pubRes);

    const unlinkRes = await harness.client.callTool({
      name: "unlink_mapping",
      arguments: {
        mapping_id: pub.mapping.id,
        delete_remote_gist: true,
        confirm_delete: true,
      },
    });
    expect(unlinkRes.isError).toBeFalsy();
    const sc = callStructured<{ deleted_remote: boolean; removed_mapping: { id: string } }>(
      unlinkRes,
    );
    expect(sc.deleted_remote).toBe(true);
    expect(sc.removed_mapping.id).toBe(pub.mapping.id);

    expect(harness.gistStore.gists.has(pub.gist_id)).toBe(false);
    const mappingsRes = await harness.client.readResource({ uri: "gistjet://mappings" });
    const payload = JSON.parse((mappingsRes.contents[0] as { text: string }).text) as {
      mappings: ReadonlyArray<{ id: string }>;
    };
    expect(payload.mappings.some((m) => m.id === pub.mapping.id)).toBe(false);
  });

  it("unlink without delete_remote_gist leaves the remote gist intact", async () => {
    const file = path.join(harness.workspaceRoot, "notes.md");
    await fsp.writeFile(file, "hello\n", "utf8");
    const pubRes = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: file },
    });
    const pub = callStructured<PublishResponse>(pubRes);

    const unlinkRes = await harness.client.callTool({
      name: "unlink_mapping",
      arguments: { mapping_id: pub.mapping.id },
    });
    expect(unlinkRes.isError).toBeFalsy();
    const sc = callStructured<{ deleted_remote: boolean }>(unlinkRes);
    expect(sc.deleted_remote).toBe(false);
    expect(harness.gistStore.gists.has(pub.gist_id)).toBe(true);
  });
});
