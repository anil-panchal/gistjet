import { describe, expect, it } from "vitest";

import { handlers } from "../msw/handlers";
import { server } from "../msw/server";

describe("MSW server module (task 1.3)", () => {
  it("exports a setupServer instance with lifecycle methods", () => {
    expect(typeof server.listen).toBe("function");
    expect(typeof server.close).toBe("function");
    expect(typeof server.resetHandlers).toBe("function");
    expect(typeof server.use).toBe("function");
  });

  it("ships handlers for the five MVP gist endpoints", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(5);
  });
});

describe("MSW GitHub Gists handlers (task 1.3)", () => {
  it("intercepts GET /gists and returns an array", async () => {
    const res = await fetch("https://api.github.com/gists");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  it("intercepts POST /gists and returns 201 with an id", async () => {
    const res = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "test",
        public: false,
        files: { "a.md": { content: "hello" } },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id?: string };
    expect(typeof body.id).toBe("string");
  });

  it("intercepts GET /gists/:id and echoes the requested id", async () => {
    const res = await fetch("https://api.github.com/gists/abc123");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toBe("abc123");
  });

  it("intercepts PATCH /gists/:id and returns 200", async () => {
    const res = await fetch("https://api.github.com/gists/abc123", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "updated" }),
    });
    expect(res.status).toBe(200);
  });

  it("intercepts DELETE /gists/:id and returns 204", async () => {
    const res = await fetch("https://api.github.com/gists/abc123", { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});
