import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createOctokitGistAdapter } from "../../src/adapters/octokit-gist";
import type { UpdateGistInput } from "../../src/shared/ports/github-gist";
import { isOk } from "../../src/shared/result";
import { server } from "../msw/server";

const API = "https://api.github.com";

function adapter() {
  return createOctokitGistAdapter({ auth: "t" });
}

describe("OctokitGistAdapter visibility immutability (task 5.6)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("UpdateGistInput has no `public` field at the type level", () => {
    // If someone ever adds `public` to UpdateGistInput, this line fails to compile.
    type Keys = keyof UpdateGistInput;
    const forbidden: Exclude<Keys, "gistId" | "description" | "files"> = undefined as never;
    expect(forbidden).toBeUndefined();
  });

  it("update() never includes a `public` field in the PATCH body", async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.patch(`${API}/gists/g-imm`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "g-imm",
          html_url: "https://gist.github.com/g-imm",
          description: "x",
          public: false,
          updated_at: "2026-04-17T00:00:00Z",
          files: {},
          history: [{ version: "sha" }],
        });
      }),
    );
    const res = await adapter().update({
      gistId: "g-imm",
      description: "just description",
      files: { "a.md": { content: "x" } },
    });
    expect(isOk(res)).toBe(true);
    expect(body).toBeDefined();
    expect(Object.keys(body ?? {})).not.toContain("public");
  });

  it("preserves the remote gist's public flag in the returned GistMeta (secret stays secret)", async () => {
    server.use(
      http.patch(`${API}/gists/g-secret`, () =>
        HttpResponse.json({
          id: "g-secret",
          html_url: "https://gist.github.com/g-secret",
          description: null,
          public: false,
          updated_at: "2026-04-17T00:00:00Z",
          files: {},
          history: [{ version: "sha" }],
        }),
      ),
    );
    const res = await adapter().update({
      gistId: "g-secret",
      files: { "a.md": { content: "x" } },
    });
    expect(isOk(res) && res.value.public).toBe(false);
  });

  it("preserves the remote gist's public flag for a public gist as well", async () => {
    server.use(
      http.patch(`${API}/gists/g-public`, () =>
        HttpResponse.json({
          id: "g-public",
          html_url: "https://gist.github.com/g-public",
          description: null,
          public: true,
          updated_at: "2026-04-17T00:00:00Z",
          files: {},
          history: [{ version: "sha" }],
        }),
      ),
    );
    const res = await adapter().update({
      gistId: "g-public",
      files: { "a.md": { content: "x" } },
    });
    expect(isOk(res) && res.value.public).toBe(true);
  });
});
