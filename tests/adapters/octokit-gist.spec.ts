import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createOctokitGistAdapter, MAX_FILES_PER_GIST } from "../../src/adapters/octokit-gist";
import { isErr, isOk } from "../../src/shared/result";
import { server } from "../msw/server";

const API = "https://api.github.com";

function adapter() {
  return createOctokitGistAdapter({ auth: "test-token" });
}

describe("OctokitGistAdapter.create (task 5.1)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("POSTs to /gists and returns a GistMeta built from the response", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedAuth: string | null = null;
    server.use(
      http.post(`${API}/gists`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        capturedAuth = request.headers.get("authorization");
        return HttpResponse.json(
          {
            id: "g-1",
            html_url: "https://gist.github.com/g-1",
            description: "hello",
            public: false,
            updated_at: "2026-04-17T00:00:00Z",
            files: {
              "a.md": {
                filename: "a.md",
                type: "text/markdown",
                raw_url: "https://gist.githubusercontent.com/raw/a.md",
                size: 5,
                truncated: false,
              },
            },
            history: [{ version: "sha-1" }],
          },
          { status: 201 },
        );
      }),
    );

    const res = await adapter().create({
      description: "hello",
      public: false,
      files: { "a.md": { content: "hello" } },
    });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.gistId).toBe("g-1");
    expect(res.value.revision).toBe("sha-1");
    expect(res.value.public).toBe(false);
    expect(res.value.files).toHaveLength(1);
    expect(res.value.files[0]?.filename).toBe("a.md");
    expect(res.value.files[0]?.rawUrl).toBe("https://gist.githubusercontent.com/raw/a.md");
    expect(res.value.files[0]?.sizeBytes).toBe(5);
    expect(capturedBody?.public).toBe(false);
    expect(capturedBody?.description).toBe("hello");
    expect(capturedAuth).toMatch(/test-token/);
  });

  it("rejects create input with more than 300 files without hitting the network", async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/gists`, () => {
        calls++;
        return HttpResponse.json({}, { status: 201 });
      }),
    );
    const files: Record<string, { content: string }> = {};
    for (let i = 0; i < MAX_FILES_PER_GIST + 1; i++) {
      files[`f${i}.txt`] = { content: String(i) };
    }
    const res = await adapter().create({ public: false, files });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("E_INPUT");
    if (res.error.code !== "E_INPUT") return;
    expect(res.error.issues[0]).toMatch(/301/);
    expect(calls).toBe(0);
  });

  it("accepts exactly 300 files (boundary case)", async () => {
    server.use(
      http.post(`${API}/gists`, () =>
        HttpResponse.json(
          {
            id: "g-boundary",
            html_url: "https://gist.github.com/g-boundary",
            description: null,
            public: false,
            updated_at: "2026-04-17T00:00:00Z",
            files: {},
            history: [{ version: "sha" }],
          },
          { status: 201 },
        ),
      ),
    );
    const files: Record<string, { content: string }> = {};
    for (let i = 0; i < MAX_FILES_PER_GIST; i++) {
      files[`f${i}.txt`] = { content: String(i) };
    }
    const res = await adapter().create({ public: false, files });
    expect(isOk(res)).toBe(true);
  });
});

describe("OctokitGistAdapter.update (task 5.1)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("issues a single PATCH with add/rename/delete semantics preserved in the body", async () => {
    let calls = 0;
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch(`${API}/gists/g-42`, async ({ request }) => {
        calls++;
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "g-42",
          html_url: "https://gist.github.com/g-42",
          description: null,
          public: false,
          updated_at: "2026-04-17T00:01:00Z",
          files: {
            "added.md": { filename: "added.md", size: 3, truncated: false, raw_url: "r1" },
            "renamed.md": { filename: "renamed.md", size: 9, truncated: false, raw_url: "r2" },
          },
          history: [{ version: "sha-next" }],
        });
      }),
    );

    const res = await adapter().update({
      gistId: "g-42",
      files: {
        "added.md": { content: "abc" },
        "oldname.md": { filename: "renamed.md" },
        "deleted.md": null,
      },
    });
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(calls).toBe(1);
    expect(res.value.revision).toBe("sha-next");
    expect(body).toBeDefined();
    const files = body?.files as Record<string, unknown> | undefined;
    expect(files).toBeDefined();
    expect(files?.["added.md"]).toEqual({ content: "abc" });
    expect(files?.["oldname.md"]).toEqual({ filename: "renamed.md" });
    expect(files?.["deleted.md"]).toBeNull();
  });
});

describe("OctokitGistAdapter.get (task 5.1)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("returns a GistFull with per-file content populated", async () => {
    server.use(
      http.get(`${API}/gists/g-7`, () =>
        HttpResponse.json({
          id: "g-7",
          html_url: "https://gist.github.com/g-7",
          description: "demo",
          public: true,
          updated_at: "2026-04-17T01:00:00Z",
          files: {
            "a.md": {
              filename: "a.md",
              size: 5,
              truncated: false,
              raw_url: "https://raw/a.md",
              content: "hello",
            },
            "b.md": {
              filename: "b.md",
              size: 3,
              truncated: false,
              raw_url: "https://raw/b.md",
              content: "bye",
            },
          },
          history: [{ version: "sha-get" }],
        }),
      ),
    );
    const res = await adapter().get("g-7");
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.gistId).toBe("g-7");
    expect(res.value.public).toBe(true);
    const byName = Object.fromEntries(res.value.files.map((f) => [f.filename, f]));
    expect(byName["a.md"]?.content).toBe("hello");
    expect(byName["b.md"]?.content).toBe("bye");
    expect(byName["b.md"]?.truncated).toBe(false);
  });
});

describe("OctokitGistAdapter.list (task 5.1)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  function summaryGist(id: string): Record<string, unknown> {
    return {
      id,
      html_url: `https://gist.github.com/${id}`,
      description: null,
      public: false,
      updated_at: "2026-04-17T00:00:00Z",
      files: { [`${id}.md`]: { filename: `${id}.md` } },
    };
  }

  it("returns summaries and no cursor when a single page is not full", async () => {
    let capturedUrl = "";
    server.use(
      http.get(`${API}/gists`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([summaryGist("g-1"), summaryGist("g-2")]);
      }),
    );
    const res = await adapter().list();
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.items).toHaveLength(2);
    expect(res.value.items[0]?.filenames).toEqual(["g-1.md"]);
    expect(res.value.nextCursor).toBeUndefined();
    expect(capturedUrl).toContain("page=1");
  });

  it("emits a nextCursor when a page is full and uses it on the next request", async () => {
    const pages: Record<string, unknown[]> = {
      "1": Array.from({ length: 30 }, (_, i) => summaryGist(`g-${i}`)),
      "2": [summaryGist("g-30")],
    };
    const seenPages: string[] = [];
    server.use(
      http.get(`${API}/gists`, ({ request }) => {
        const url = new URL(request.url);
        const page = url.searchParams.get("page") ?? "1";
        seenPages.push(page);
        return HttpResponse.json(pages[page] ?? []);
      }),
    );
    const a = await adapter().list();
    expect(isOk(a) && a.value.items).toHaveLength(30);
    expect(isOk(a) && a.value.nextCursor).toBe("2");
    const b = await adapter().list(a.ok ? a.value.nextCursor : undefined);
    expect(isOk(b) && b.value.items).toHaveLength(1);
    expect(isOk(b) && b.value.nextCursor).toBeUndefined();
    expect(seenPages).toEqual(["1", "2"]);
  });

  it("rejects an invalid cursor before issuing a request", async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/gists`, () => {
        calls++;
        return HttpResponse.json([]);
      }),
    );
    const res = await adapter().list("not-a-number");
    expect(isErr(res) && res.error.code).toBe("E_INPUT");
    expect(calls).toBe(0);
  });
});

describe("OctokitGistAdapter.delete (task 5.1)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("calls DELETE /gists/:id and returns ok(undefined) on success", async () => {
    let seen = "";
    server.use(
      http.delete(`${API}/gists/:id`, ({ params }) => {
        seen = String(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const res = await adapter().delete("g-del");
    expect(isOk(res)).toBe(true);
    expect(seen).toBe("g-del");
  });
});
