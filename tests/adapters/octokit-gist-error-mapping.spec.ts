import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createOctokitGistAdapter } from "../../src/adapters/octokit-gist";
import { isErr } from "../../src/shared/result";
import { server } from "../msw/server";

const API = "https://api.github.com";

function adapter() {
  return createOctokitGistAdapter({ auth: "t" });
}

describe("OctokitGistAdapter HTTP error mapping (task 5.5)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("maps 401 to E_AUTH invalid_token", async () => {
    server.use(
      http.get(`${API}/gists/g-1`, () =>
        HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );
    const res = await adapter().get("g-1");
    expect(isErr(res) && res.error.code).toBe("E_AUTH");
    if (!isErr(res) || res.error.code !== "E_AUTH") return;
    expect(res.error.detail).toBe("invalid_token");
  });

  it("maps 403 without rate-limit headers to E_AUTH missing_permission", async () => {
    server.use(
      http.get(`${API}/gists/g-2`, () =>
        HttpResponse.json({ message: "Must have admin rights" }, { status: 403 }),
      ),
    );
    const res = await adapter().get("g-2");
    expect(isErr(res) && res.error.code).toBe("E_AUTH");
    if (!isErr(res) || res.error.code !== "E_AUTH") return;
    expect(res.error.detail).toBe("missing_permission");
  });

  it("keeps 403 with rate-limit headers routed to E_RATE_LIMIT (does not regress 5.2)", async () => {
    server.use(
      http.get(`${API}/gists/g-3`, () =>
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
    const res = await adapter().get("g-3");
    expect(isErr(res) && res.error.code).toBe("E_RATE_LIMIT");
  });

  it("maps 404 to E_NOT_FOUND and surfaces the request path as the resource identifier", async () => {
    server.use(
      http.get(`${API}/gists/g-missing`, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const res = await adapter().get("g-missing");
    expect(isErr(res) && res.error.code).toBe("E_NOT_FOUND");
    if (!isErr(res) || res.error.code !== "E_NOT_FOUND") return;
    expect(res.error.resource).toContain("g-missing");
  });

  it("maps 422 to E_INPUT and carries each validation issue as a string", async () => {
    server.use(
      http.post(`${API}/gists`, () =>
        HttpResponse.json(
          {
            message: "Validation Failed",
            errors: [
              { resource: "Gist", code: "missing_field", field: "files" },
              { resource: "Gist", code: "custom", field: "description", message: "too long" },
            ],
          },
          { status: 422 },
        ),
      ),
    );
    const res = await adapter().create({ public: false, files: { "a.md": { content: "x" } } });
    expect(isErr(res) && res.error.code).toBe("E_INPUT");
    if (!isErr(res) || res.error.code !== "E_INPUT") return;
    expect(res.error.issues.length).toBeGreaterThanOrEqual(2);
    expect(res.error.issues.some((s) => s.includes("files"))).toBe(true);
    expect(res.error.issues.some((s) => s.includes("description"))).toBe(true);
  });

  it("maps 500 to E_INTERNAL", async () => {
    server.use(
      http.get(`${API}/gists/g-5xx`, () =>
        HttpResponse.json({ message: "Internal Server Error" }, { status: 500 }),
      ),
    );
    const res = await adapter().get("g-5xx");
    expect(isErr(res) && res.error.code).toBe("E_INTERNAL");
  });

  it("maps 502/503/504 to E_INTERNAL", async () => {
    for (const status of [502, 503, 504]) {
      server.use(
        http.delete(`${API}/gists/:id`, () =>
          HttpResponse.json({ message: `status ${status}` }, { status }),
        ),
      );
      const res = await adapter().delete(`g-${status}`);
      expect(isErr(res) && res.error.code).toBe("E_INTERNAL");
      server.resetHandlers();
    }
  });
});
