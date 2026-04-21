import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createOctokitGistAdapter } from "../../src/adapters/octokit-gist";
import { isErr, isOk } from "../../src/shared/result";
import { server } from "../msw/server";

const API = "https://api.github.com";

function adapter() {
  return createOctokitGistAdapter({ auth: "t" });
}

describe("OctokitGistAdapter.probeGistAccess (task 5.4)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("returns { login, scopesHeader } using the first gist's owner.login and x-oauth-scopes header", async () => {
    let seenUrl = "";
    server.use(
      http.get(`${API}/gists`, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(
          [
            {
              id: "g-1",
              html_url: "https://gist.github.com/g-1",
              public: false,
              description: null,
              updated_at: "2026-04-17T00:00:00Z",
              files: { "a.md": { filename: "a.md" } },
              owner: { login: "octocat" },
            },
          ],
          { headers: { "x-oauth-scopes": "gist, repo" } },
        );
      }),
    );
    const res = await adapter().probeGistAccess();
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.login).toBe("octocat");
    expect(res.value.scopesHeader).toBe("gist, repo");
    expect(seenUrl).toContain("per_page=1");
  });

  it("returns scopesHeader: null when the GitHub response omits x-oauth-scopes (fine-grained PAT)", async () => {
    server.use(
      http.get(`${API}/gists`, () =>
        HttpResponse.json([
          {
            id: "g-1",
            html_url: "https://gist.github.com/g-1",
            public: false,
            description: null,
            updated_at: "2026-04-17T00:00:00Z",
            files: {},
            owner: { login: "finelady" },
          },
        ]),
      ),
    );
    const res = await adapter().probeGistAccess();
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.login).toBe("finelady");
    expect(res.value.scopesHeader).toBeNull();
  });

  it("falls back to GET /user when the user has zero gists and uses its login", async () => {
    let gistsCalled = 0;
    let userCalled = 0;
    server.use(
      http.get(`${API}/gists`, () => {
        gistsCalled++;
        return HttpResponse.json([], { headers: { "x-oauth-scopes": "gist" } });
      }),
      http.get(`${API}/user`, () => {
        userCalled++;
        return HttpResponse.json({ login: "emptyuser" });
      }),
    );
    const res = await adapter().probeGistAccess();
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.login).toBe("emptyuser");
    expect(res.value.scopesHeader).toBe("gist");
    expect(gistsCalled).toBe(1);
    expect(userCalled).toBe(1);
  });

  it("propagates rate-limit signals on the probe call to E_RATE_LIMIT", async () => {
    server.use(
      http.get(`${API}/gists`, () =>
        HttpResponse.json(
          { message: "rate limited" },
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
            },
          },
        ),
      ),
    );
    const res = await adapter().probeGistAccess();
    expect(isErr(res) && res.error.code).toBe("E_RATE_LIMIT");
  });

  it("returns E_INTERNAL when the probe response cannot classify login (owner missing and /user unreachable)", async () => {
    server.use(
      http.get(`${API}/gists`, () => HttpResponse.json([])),
      http.get(`${API}/user`, () => new HttpResponse("nope", { status: 500 })),
    );
    const res = await adapter().probeGistAccess();
    expect(isErr(res) && res.error.code).toBe("E_INTERNAL");
  });
});
