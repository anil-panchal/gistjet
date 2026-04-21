import { promises as fsp } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { callError, callStructured, makeE2EHarness, type E2EHarness } from "./harness";

type PublishResponse = {
  gist_id: string;
  mapping: { id: string; local_path: string };
};

async function initAndPublish(
  harness: E2EHarness,
  opts: { content: string; filename?: string },
): Promise<PublishResponse> {
  await harness.client.callTool({
    name: "init_workspace",
    arguments: { target_dir: harness.workspaceRoot },
  });
  const filename = opts.filename ?? "notes.md";
  const file = path.join(harness.workspaceRoot, filename);
  await fsp.writeFile(file, opts.content, "utf8");
  const res = await harness.client.callTool({
    name: "publish_path_to_gist",
    arguments: { path: file },
  });
  expect(res.isError).toBeFalsy();
  return callStructured<PublishResponse>(res);
}

describe("E2E sync flow (task 10.2, req 3.1/3.3/3.6/3.7, 12.1/12.3/12.4/12.5, 17.1/17.2/17.3/17.4)", () => {
  let harness: E2EHarness;

  beforeEach(async () => {
    harness = await makeE2EHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("local_ahead: sync pushes edited local file to remote (classification=local_ahead)", async () => {
    const pub = await initAndPublish(harness, { content: "v1\n" });
    const file = path.join(harness.workspaceRoot, "notes.md");
    await fsp.writeFile(file, "v2-edited\n", "utf8");

    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: pub.mapping.id },
    });
    expect(res.isError).toBeFalsy();
    const sc = callStructured<{ classification: string; applied: boolean }>(res);
    expect(sc.classification).toBe("local_ahead");
    expect(sc.applied).toBe(true);
    expect(harness.gistStore.gists.get(pub.gist_id)?.files["notes.md"]?.content).toBe(
      "v2-edited\n",
    );
  });

  it("remote_ahead without confirm_overwrite_local returns E_LOCAL_OVERWRITE_CONFIRM", async () => {
    const pub = await initAndPublish(harness, { content: "remote-will-advance\n" });
    // Mutate remote directly — local stays the same, mapping's last_remote_revision lags.
    const gist = harness.gistStore.gists.get(pub.gist_id)!;
    gist.files["notes.md"] = { content: "remote-updated\n" };
    gist.revision = `${gist.revision}-advanced`;

    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: pub.mapping.id },
    });
    expect(res.isError).toBe(true);
    const sc = callError<{ code: string; details: { files: readonly unknown[] } }>(res);
    expect(sc.code).toBe("E_LOCAL_OVERWRITE_CONFIRM");
    expect(sc.details.files.length).toBeGreaterThan(0);

    // Local file unchanged.
    const local = await fsp.readFile(path.join(harness.workspaceRoot, "notes.md"), "utf8");
    expect(local).toBe("remote-will-advance\n");
  });

  it("remote_ahead with confirm_overwrite_local=true writes the remote content locally", async () => {
    const pub = await initAndPublish(harness, { content: "remote-will-advance\n" });
    const gist = harness.gistStore.gists.get(pub.gist_id)!;
    gist.files["notes.md"] = { content: "remote-updated\n" };
    gist.revision = `${gist.revision}-advanced`;

    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: pub.mapping.id, confirm_overwrite_local: true },
    });
    expect(res.isError).toBeFalsy();
    const sc = callStructured<{ classification: string; applied: boolean }>(res);
    expect(sc.classification).toBe("remote_ahead");
    expect(sc.applied).toBe(true);
    const local = await fsp.readFile(path.join(harness.workspaceRoot, "notes.md"), "utf8");
    expect(local).toBe("remote-updated\n");
  });

  it("diverged with on_conflict=prefer_local pushes local over remote", async () => {
    const pub = await initAndPublish(harness, { content: "base\n" });
    // Both sides advance.
    await fsp.writeFile(path.join(harness.workspaceRoot, "notes.md"), "local-branch\n", "utf8");
    const gist = harness.gistStore.gists.get(pub.gist_id)!;
    gist.files["notes.md"] = { content: "remote-branch\n" };
    gist.revision = `${gist.revision}-advanced`;

    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: {
        mapping_id: pub.mapping.id,
        on_conflict: "prefer_local",
      },
    });
    expect(res.isError).toBeFalsy();
    const sc = callStructured<{ classification: string; applied: boolean }>(res);
    expect(sc.classification).toBe("diverged");
    expect(sc.applied).toBe(true);
    expect(harness.gistStore.gists.get(pub.gist_id)?.files["notes.md"]?.content).toBe(
      "local-branch\n",
    );
  });

  it("diverged with on_conflict=prefer_remote pulls remote over local (needs confirm_overwrite_local)", async () => {
    const pub = await initAndPublish(harness, { content: "base\n" });
    await fsp.writeFile(path.join(harness.workspaceRoot, "notes.md"), "local-branch\n", "utf8");
    const gist = harness.gistStore.gists.get(pub.gist_id)!;
    gist.files["notes.md"] = { content: "remote-branch\n" };
    gist.revision = `${gist.revision}-advanced`;

    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: {
        mapping_id: pub.mapping.id,
        on_conflict: "prefer_remote",
        confirm_overwrite_local: true,
      },
    });
    expect(res.isError).toBeFalsy();
    const sc = callStructured<{ classification: string; applied: boolean }>(res);
    expect(sc.classification).toBe("diverged");
    expect(sc.applied).toBe(true);
    const local = await fsp.readFile(path.join(harness.workspaceRoot, "notes.md"), "utf8");
    expect(local).toBe("remote-branch\n");
  });

  it("diverged with on_conflict=abort returns E_CONFLICT and writes nothing", async () => {
    const pub = await initAndPublish(harness, { content: "base\n" });
    await fsp.writeFile(path.join(harness.workspaceRoot, "notes.md"), "local-branch\n", "utf8");
    const gist = harness.gistStore.gists.get(pub.gist_id)!;
    gist.files["notes.md"] = { content: "remote-branch\n" };
    gist.revision = `${gist.revision}-advanced`;

    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: {
        mapping_id: pub.mapping.id,
        on_conflict: "abort",
      },
    });
    expect(res.isError).toBe(true);
    const sc = callError<{ code: string; details: { classification: string } }>(res);
    expect(sc.code).toBe("E_CONFLICT");
    expect(sc.details.classification).toBe("diverged");

    // Neither side changed.
    expect(await fsp.readFile(path.join(harness.workspaceRoot, "notes.md"), "utf8")).toBe(
      "local-branch\n",
    );
    expect(harness.gistStore.gists.get(pub.gist_id)?.files["notes.md"]?.content).toBe(
      "remote-branch\n",
    );
  });

  it("dry_run on a local_ahead change reports the plan but writes nothing remote", async () => {
    const pub = await initAndPublish(harness, { content: "v1\n" });
    await fsp.writeFile(path.join(harness.workspaceRoot, "notes.md"), "v2-dryrun\n", "utf8");
    const baselineRemote = harness.gistStore.gists.get(pub.gist_id)?.files["notes.md"]?.content;

    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: pub.mapping.id, dry_run: true },
    });
    expect(res.isError).toBeFalsy();
    const sc = callStructured<{
      classification: string;
      applied: boolean;
      plan: ReadonlyArray<{ filename: string; kind: string }>;
    }>(res);
    expect(sc.classification).toBe("local_ahead");
    expect(sc.applied).toBe(false);
    expect(sc.plan.length).toBeGreaterThan(0);
    // Remote content unchanged.
    expect(harness.gistStore.gists.get(pub.gist_id)?.files["notes.md"]?.content).toBe(
      baselineRemote,
    );
  });

  it("local_missing short-circuits with E_LOCAL_MISSING and promotes mapping status", async () => {
    const pub = await initAndPublish(harness, { content: "orig\n" });
    await fsp.rm(path.join(harness.workspaceRoot, "notes.md"));

    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: { mapping_id: pub.mapping.id },
    });
    expect(res.isError).toBe(true);
    const sc = callError<{ code: string; details: { mappingId: string } }>(res);
    expect(sc.code).toBe("E_LOCAL_MISSING");
    expect(sc.details.mappingId).toBe(pub.mapping.id);

    // Mapping status should now be local_missing.
    const mappingsRes = await harness.client.readResource({ uri: "gistjet://mappings" });
    const payload = JSON.parse((mappingsRes.contents[0] as { text: string }).text) as {
      mappings: ReadonlyArray<{ id: string; status: string }>;
    };
    const updated = payload.mappings.find((m) => m.id === pub.mapping.id);
    expect(updated?.status).toBe("local_missing");
  });

  it("pull plans that target hardened-ignore paths surface them in ignored_on_pull and do not overwrite them", async () => {
    // Workspace with a folder mapping — publish `site/`, then make it look
    // remote-ahead by having the gist list a `.env` file that pull would
    // want to write. The hardened ignore engine strips it silently.
    await harness.client.callTool({
      name: "init_workspace",
      arguments: { target_dir: harness.workspaceRoot },
    });
    const folder = path.join(harness.workspaceRoot, "site");
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, "index.html"), "<h1>a</h1>\n", "utf8");
    const pubRes = await harness.client.callTool({
      name: "publish_path_to_gist",
      arguments: { path: folder },
    });
    expect(pubRes.isError).toBeFalsy();
    const pub = callStructured<PublishResponse>(pubRes);

    // Make remote advance and add a .env that pull would write — gate must drop it.
    const gist = harness.gistStore.gists.get(pub.gist_id)!;
    gist.files["index.html"] = { content: "<h1>b-remote</h1>\n" };
    gist.files[".env"] = { content: "SECRET=leaked\n" };
    gist.revision = `${gist.revision}-advanced`;

    const res = await harness.client.callTool({
      name: "sync_path_to_gist",
      arguments: {
        mapping_id: pub.mapping.id,
        confirm_overwrite_local: true,
      },
    });
    expect(res.isError).toBeFalsy();
    const sc = callStructured<{ ignored_on_pull?: readonly string[] }>(res);
    expect(sc.ignored_on_pull).toBeDefined();
    expect(sc.ignored_on_pull).toContain(".env");
    // Local .env must never have been created.
    const envExists = await fsp
      .stat(path.join(folder, ".env"))
      .then(() => true)
      .catch(() => false);
    expect(envExists).toBe(false);
  });
});
