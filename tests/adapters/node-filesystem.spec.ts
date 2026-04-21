import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeFileSystem } from "../../src/adapters/node-filesystem";
import { isErr, isOk } from "../../src/shared/result";

async function makeTempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "gistjet-fs-"));
}

async function cleanup(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}

describe("NodeFileSystem.stat (task 4.1)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempRoot();
  });
  afterEach(async () => {
    await cleanup(tmp);
  });

  it("returns FileInfo for an existing text file with size and mtime", async () => {
    const target = path.join(tmp, "hello.txt");
    await fs.writeFile(target, "hi there", "utf8");
    const nfs = createNodeFileSystem({ workspaceRoot: tmp });
    const res = await nfs.stat(target);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.absolutePath).toBe(path.resolve(target));
    expect(res.value.relativePath).toBe("hello.txt");
    expect(res.value.sizeBytes).toBe(Buffer.byteLength("hi there", "utf8"));
    expect(res.value.isDirectory).toBe(false);
    expect(res.value.isBinaryHint).toBe(false);
    expect(typeof res.value.mtimeMs).toBe("number");
  });

  it("flags a directory via isDirectory and not isBinaryHint", async () => {
    const dir = path.join(tmp, "sub");
    await fs.mkdir(dir);
    const nfs = createNodeFileSystem({ workspaceRoot: tmp });
    const res = await nfs.stat(dir);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.isDirectory).toBe(true);
    expect(res.value.isBinaryHint).toBe(false);
  });

  it("marks known binary extensions as isBinaryHint: true without reading content", async () => {
    const target = path.join(tmp, "image.png");
    await fs.writeFile(target, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const nfs = createNodeFileSystem({ workspaceRoot: tmp });
    const res = await nfs.stat(target);
    expect(isOk(res) && res.value.isBinaryHint).toBe(true);
  });

  it("returns E_NOT_FOUND when the path is missing", async () => {
    const nfs = createNodeFileSystem({ workspaceRoot: tmp });
    const res = await nfs.stat(path.join(tmp, "ghost.txt"));
    expect(isErr(res) && res.error.code).toBe("E_NOT_FOUND");
  });

  it("produces a forward-slash relativePath regardless of OS separator", async () => {
    const sub = path.join(tmp, "a", "b");
    await fs.mkdir(sub, { recursive: true });
    const target = path.join(sub, "deep.txt");
    await fs.writeFile(target, "x");
    const nfs = createNodeFileSystem({ workspaceRoot: tmp });
    const res = await nfs.stat(target);
    expect(isOk(res) && res.value.relativePath).toBe("a/b/deep.txt");
  });
});

describe("NodeFileSystem.read (task 4.1)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempRoot();
  });
  afterEach(async () => {
    await cleanup(tmp);
  });

  it("returns a text FileContent for a valid UTF-8 file", async () => {
    const target = path.join(tmp, "note.md");
    await fs.writeFile(target, "# hello\nUtf-8 café", "utf8");
    const nfs = createNodeFileSystem();
    const res = await nfs.read(target);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.kind).toBe("text");
    if (res.value.kind !== "text") return;
    expect(res.value.value).toBe("# hello\nUtf-8 café");
    expect(res.value.encoding).toBe("utf8");
  });

  it("returns a binary FileContent when NUL bytes are present", async () => {
    const target = path.join(tmp, "blob.dat");
    await fs.writeFile(target, Buffer.from([0x41, 0x00, 0x42, 0x43]));
    const nfs = createNodeFileSystem();
    const res = await nfs.read(target);
    expect(isOk(res)).toBe(true);
    if (!isOk(res) || res.value.kind !== "binary") {
      throw new Error("expected binary content");
    }
    expect(Array.from(res.value.value)).toEqual([0x41, 0x00, 0x42, 0x43]);
  });

  it("returns a binary FileContent for known binary extensions even with text-looking bytes", async () => {
    const target = path.join(tmp, "image.png");
    await fs.writeFile(target, "not really a png");
    const nfs = createNodeFileSystem();
    const res = await nfs.read(target);
    expect(isOk(res) && res.value.kind).toBe("binary");
  });

  it("returns a binary FileContent when the caller opts in via asBuffer: true", async () => {
    const target = path.join(tmp, "readable.txt");
    await fs.writeFile(target, "plain text");
    const nfs = createNodeFileSystem();
    const res = await nfs.read(target, { asBuffer: true });
    expect(isOk(res) && res.value.kind).toBe("binary");
  });

  it("returns E_NOT_FOUND when the file is missing", async () => {
    const nfs = createNodeFileSystem();
    const res = await nfs.read(path.join(tmp, "missing.txt"));
    expect(isErr(res) && res.error.code).toBe("E_NOT_FOUND");
  });

  it("returns E_IO when the path points to a directory", async () => {
    const dir = path.join(tmp, "dir");
    await fs.mkdir(dir);
    const nfs = createNodeFileSystem();
    const res = await nfs.read(dir);
    expect(isErr(res) && res.error.code).toBe("E_IO");
  });

  it("rejects invalid UTF-8 sequences by returning binary content rather than garbled text", async () => {
    const target = path.join(tmp, "bad-utf.txt");
    // Lone continuation byte — invalid UTF-8, no NUL.
    await fs.writeFile(target, Buffer.from([0x80, 0x41, 0x42]));
    const nfs = createNodeFileSystem();
    const res = await nfs.read(target);
    expect(isOk(res) && res.value.kind).toBe("binary");
  });
});

describe("NodeFileSystem.writeAtomic (task 4.1)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempRoot();
  });
  afterEach(async () => {
    await cleanup(tmp);
  });

  it("writes a string payload and creates parent directories", async () => {
    const target = path.join(tmp, "nested", "sub", "file.txt");
    const nfs = createNodeFileSystem();
    const res = await nfs.writeAtomic(target, "content");
    expect(isOk(res)).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("content");
  });

  it("preserves original bytes when given a Uint8Array (no LF normalization in the port)", async () => {
    const target = path.join(tmp, "bytes.bin");
    const bytes = new Uint8Array([0x0d, 0x0a, 0x00, 0xff, 0x41]);
    const nfs = createNodeFileSystem();
    const res = await nfs.writeAtomic(target, bytes);
    expect(isOk(res)).toBe(true);
    const readBack = await fs.readFile(target);
    expect(Array.from(readBack)).toEqual(Array.from(bytes));
  });

  it("overwrites an existing file atomically without leaving a temp sibling behind", async () => {
    const target = path.join(tmp, "over.txt");
    await fs.writeFile(target, "old");
    const nfs = createNodeFileSystem();
    const res = await nfs.writeAtomic(target, "new");
    expect(isOk(res)).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("new");
    const entries = await fs.readdir(tmp);
    expect(entries.filter((name) => name !== "over.txt")).toEqual([]);
  });
});

describe("NodeFileSystem.enumerate (task 4.1)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await makeTempRoot();
  });
  afterEach(async () => {
    await cleanup(tmp);
  });

  it("yields every file and directory recursively with forward-slash relative paths", async () => {
    await fs.mkdir(path.join(tmp, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(tmp, "root.txt"), "r");
    await fs.writeFile(path.join(tmp, "a", "one.txt"), "1");
    await fs.writeFile(path.join(tmp, "a", "b", "two.txt"), "2");

    const nfs = createNodeFileSystem({ workspaceRoot: tmp });
    const infos: Array<{ rel: string; dir: boolean }> = [];
    for await (const info of nfs.enumerate(tmp)) {
      infos.push({ rel: info.relativePath, dir: info.isDirectory });
    }
    const rels = infos.map((i) => i.rel).sort();
    expect(rels).toEqual(["a", "a/b", "a/b/two.txt", "a/one.txt", "root.txt"]);
    const twoTxt = infos.find((i) => i.rel === "a/b/two.txt");
    expect(twoTxt?.dir).toBe(false);
    const dirA = infos.find((i) => i.rel === "a");
    expect(dirA?.dir).toBe(true);
  });

  it("flags isBinaryHint by extension during enumeration without reading content", async () => {
    await fs.writeFile(path.join(tmp, "pic.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    await fs.writeFile(path.join(tmp, "note.txt"), "plain");
    const nfs = createNodeFileSystem({ workspaceRoot: tmp });
    const infos = [] as Array<{ name: string; binary: boolean }>;
    for await (const info of nfs.enumerate(tmp)) {
      if (info.isDirectory) continue;
      infos.push({ name: path.basename(info.absolutePath), binary: info.isBinaryHint });
    }
    expect(infos.find((i) => i.name === "pic.jpg")?.binary).toBe(true);
    expect(infos.find((i) => i.name === "note.txt")?.binary).toBe(false);
  });

  it("yields nothing when the enumeration root does not exist", async () => {
    const nfs = createNodeFileSystem();
    const infos = [];
    for await (const info of nfs.enumerate(path.join(tmp, "no-such-dir"))) {
      infos.push(info);
    }
    expect(infos).toEqual([]);
  });
});
