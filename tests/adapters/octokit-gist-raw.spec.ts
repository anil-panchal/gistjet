import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createOctokitGistAdapter, MAX_RAW_FETCH_BYTES } from "../../src/adapters/octokit-gist";
import { isErr, isOk } from "../../src/shared/result";
import { server } from "../msw/server";

const API = "https://api.github.com";
const RAW = "https://gist.githubusercontent.com";

function adapter() {
  return createOctokitGistAdapter({ auth: "t" });
}

describe("OctokitGistAdapter.fetchRaw (task 5.3)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("returns ok(content) for a small text response", async () => {
    server.use(
      http.get(`${RAW}/owner/g-1/raw/sha/a.md`, () => HttpResponse.text("# hello from raw\nbody")),
    );
    const res = await adapter().fetchRaw(`${RAW}/owner/g-1/raw/sha/a.md`);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value).toBe("# hello from raw\nbody");
  });

  it("fails fast with E_TOO_LARGE when Content-Length exceeds the 10 MB limit", async () => {
    let bodyRead = false;
    server.use(
      http.get(`${RAW}/owner/g-1/raw/sha/big.bin`, () => {
        bodyRead = true;
        return new HttpResponse("x", {
          status: 200,
          headers: {
            "content-length": String(MAX_RAW_FETCH_BYTES + 1),
            "content-type": "text/plain",
          },
        });
      }),
    );
    const res = await adapter().fetchRaw(`${RAW}/owner/g-1/raw/sha/big.bin`);
    expect(isErr(res)).toBe(true);
    if (!isErr(res) || res.error.code !== "E_TOO_LARGE") return;
    expect(res.error.file).toBe("big.bin");
    expect(res.error.limit).toBe(MAX_RAW_FETCH_BYTES);
    expect(res.error.sizeBytes).toBe(MAX_RAW_FETCH_BYTES + 1);
    // handler was invoked; the guard relies on the header rather than consuming the body further
    expect(bodyRead).toBe(true);
  });

  it("returns E_TOO_LARGE when the received body exceeds the limit even without a content-length header", async () => {
    const payload = "a".repeat(MAX_RAW_FETCH_BYTES + 5);
    server.use(
      http.get(
        `${RAW}/owner/g-1/raw/sha/huge.txt`,
        () =>
          new HttpResponse(payload, {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ),
    );
    const res = await adapter().fetchRaw(`${RAW}/owner/g-1/raw/sha/huge.txt`);
    expect(isErr(res) && res.error.code).toBe("E_TOO_LARGE");
    if (!isErr(res) || res.error.code !== "E_TOO_LARGE") return;
    expect(res.error.file).toBe("huge.txt");
    expect(res.error.sizeBytes).toBeGreaterThan(MAX_RAW_FETCH_BYTES);
  });

  it("returns E_NOT_FOUND when the raw URL answers 404", async () => {
    server.use(
      http.get(
        `${RAW}/owner/g-1/raw/sha/gone.md`,
        () => new HttpResponse("not here", { status: 404 }),
      ),
    );
    const res = await adapter().fetchRaw(`${RAW}/owner/g-1/raw/sha/gone.md`);
    expect(isErr(res)).toBe(true);
    if (!isErr(res) || res.error.code !== "E_NOT_FOUND") return;
    expect(res.error.resource).toContain("gone.md");
  });

  it("returns E_INTERNAL for unexpected non-success statuses", async () => {
    server.use(
      http.get(
        `${RAW}/owner/g-1/raw/sha/boom`,
        () => new HttpResponse("server down", { status: 502 }),
      ),
    );
    const res = await adapter().fetchRaw(`${RAW}/owner/g-1/raw/sha/boom`);
    expect(isErr(res) && res.error.code).toBe("E_INTERNAL");
  });
});

describe("OctokitGistAdapter.get truncation-aware fill (task 5.3)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("auto-fills truncated file content by fetching raw_url", async () => {
    const rawUrl = `${RAW}/owner/g-42/raw/sha/big.md`;
    let rawCalls = 0;
    server.use(
      http.get(`${API}/gists/g-42`, () =>
        HttpResponse.json({
          id: "g-42",
          html_url: "https://gist.github.com/g-42",
          description: null,
          public: false,
          updated_at: "2026-04-17T00:00:00Z",
          files: {
            "small.md": {
              filename: "small.md",
              size: 4,
              truncated: false,
              raw_url: `${RAW}/owner/g-42/raw/sha/small.md`,
              content: "tiny",
            },
            "big.md": {
              filename: "big.md",
              size: 2_000_000,
              truncated: true,
              raw_url: rawUrl,
              content: null,
            },
          },
          history: [{ version: "sha" }],
        }),
      ),
      http.get(rawUrl, () => {
        rawCalls++;
        return HttpResponse.text("FULL CONTENT FOR big.md");
      }),
    );

    const res = await adapter().get("g-42");
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    const byName = Object.fromEntries(res.value.files.map((f) => [f.filename, f]));
    expect(byName["small.md"]?.content).toBe("tiny");
    expect(byName["big.md"]?.content).toBe("FULL CONTENT FOR big.md");
    expect(byName["big.md"]?.truncated).toBe(true);
    expect(rawCalls).toBe(1);
  });

  it("surfaces E_TOO_LARGE from the underlying raw fetch when a truncated file is still oversized", async () => {
    const rawUrl = `${RAW}/owner/g-43/raw/sha/too.md`;
    server.use(
      http.get(`${API}/gists/g-43`, () =>
        HttpResponse.json({
          id: "g-43",
          html_url: "https://gist.github.com/g-43",
          description: null,
          public: false,
          updated_at: "2026-04-17T00:00:00Z",
          files: {
            "too.md": {
              filename: "too.md",
              size: MAX_RAW_FETCH_BYTES + 1,
              truncated: true,
              raw_url: rawUrl,
              content: null,
            },
          },
          history: [{ version: "sha" }],
        }),
      ),
      http.get(
        rawUrl,
        () =>
          new HttpResponse("x", {
            status: 200,
            headers: { "content-length": String(MAX_RAW_FETCH_BYTES + 1) },
          }),
      ),
    );
    const res = await adapter().get("g-43");
    expect(isErr(res) && res.error.code).toBe("E_TOO_LARGE");
    if (!isErr(res) || res.error.code !== "E_TOO_LARGE") return;
    expect(res.error.file).toBe("too.md");
  });
});
