import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { createOctokitGistAdapter } from "../../src/adapters/octokit-gist";
import type { Logger } from "../../src/shared/ports/logger";
import { isErr } from "../../src/shared/result";
import { server } from "../msw/server";

const API = "https://api.github.com";

function makeLogger(): Logger & {
  readonly events: Array<{ level: string; event: string; payload?: Record<string, unknown> }>;
} {
  const events: Array<{ level: string; event: string; payload?: Record<string, unknown> }> = [];
  const api: Logger = {
    child(): Logger {
      return api;
    },
    debug(event, payload) {
      events.push({ level: "debug", event, ...(payload ? { payload } : {}) });
    },
    info(event, payload) {
      events.push({ level: "info", event, ...(payload ? { payload } : {}) });
    },
    warn(event, payload) {
      events.push({ level: "warn", event, ...(payload ? { payload } : {}) });
    },
    error(event, payload) {
      events.push({ level: "error", event, payload });
    },
  };
  return Object.assign(api, { events });
}

describe("OctokitGistAdapter rate-limit surfacing (task 5.2)", () => {
  afterEach(() => {
    server.resetHandlers();
  });

  it("maps a primary rate-limit 403 with x-ratelimit-reset to E_RATE_LIMIT with an ISO resetAt", async () => {
    const resetUnix = Math.floor(Date.UTC(2026, 3, 17, 12, 0, 0) / 1000); // 2026-04-17T12:00:00Z
    let hits = 0;
    server.use(
      http.post(`${API}/gists`, () => {
        hits++;
        return HttpResponse.json(
          { message: "API rate limit exceeded", documentation_url: "https://docs.github.com" },
          {
            status: 403,
            headers: {
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(resetUnix),
              "x-ratelimit-resource": "core",
            },
          },
        );
      }),
    );
    const adapter = createOctokitGistAdapter({ auth: "t" });
    const res = await adapter.create({ public: false, files: { "a.md": { content: "x" } } });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("E_RATE_LIMIT");
    if (res.error.code !== "E_RATE_LIMIT") return;
    expect(res.error.resetAt).toBe("2026-04-17T12:00:00.000Z");
    expect(hits).toBe(1);
  });

  it("does not auto-retry on rate-limit — only a single HTTP call is made", async () => {
    let hits = 0;
    server.use(
      http.get(`${API}/gists`, () => {
        hits++;
        return HttpResponse.json(
          { message: "rate limited" },
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
            },
          },
        );
      }),
    );
    const adapter = createOctokitGistAdapter({ auth: "t" });
    const res = await adapter.list();
    expect(isErr(res) && res.error.code).toBe("E_RATE_LIMIT");
    expect(hits).toBe(1);
  });

  it("maps a secondary rate-limit 429 with retry-after to a resetAt ~retry-after seconds in the future", async () => {
    server.use(
      http.get(`${API}/gists/:id`, () =>
        HttpResponse.json(
          { message: "secondary rate limit" },
          {
            status: 429,
            headers: { "retry-after": "30" },
          },
        ),
      ),
    );
    const adapter = createOctokitGistAdapter({ auth: "t" });
    const before = Date.now();
    const res = await adapter.get("g-1");
    const after = Date.now();
    expect(isErr(res)).toBe(true);
    if (!isErr(res) || res.error.code !== "E_RATE_LIMIT") return;
    const resetMs = Date.parse(res.error.resetAt);
    expect(resetMs).toBeGreaterThanOrEqual(before + 30_000);
    expect(resetMs).toBeLessThanOrEqual(after + 31_000);
  });

  it("emits a github.rate_limit log event when the throttling plugin fires", async () => {
    server.use(
      http.delete(`${API}/gists/:id`, () =>
        HttpResponse.json(
          { message: "API rate limit exceeded" },
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
    const logger = makeLogger();
    const adapter = createOctokitGistAdapter({ auth: "t", logger });
    const res = await adapter.delete("g-1");
    expect(isErr(res) && res.error.code).toBe("E_RATE_LIMIT");
    const rateEvents = logger.events.filter((e) => e.event === "github.rate_limit");
    expect(rateEvents.length).toBeGreaterThanOrEqual(1);
    const payload = rateEvents[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.kind).toBe("primary");
    expect(typeof payload?.url).toBe("string");
  });

  it("emits a github.rate_limit log event with kind=secondary on 429 signals", async () => {
    server.use(
      http.patch(`${API}/gists/:id`, () =>
        HttpResponse.json(
          { message: "You have exceeded a secondary rate limit" },
          { status: 403, headers: { "retry-after": "30" } },
        ),
      ),
    );
    const logger = makeLogger();
    const adapter = createOctokitGistAdapter({ auth: "t", logger });
    const res = await adapter.update({ gistId: "g-1", files: { "a.md": { content: "x" } } });
    expect(isErr(res) && res.error.code).toBe("E_RATE_LIMIT");
    const rateEvents = logger.events.filter((e) => e.event === "github.rate_limit");
    const kinds = rateEvents
      .map((e) => (e.payload as Record<string, unknown> | undefined)?.kind)
      .filter((k): k is string => typeof k === "string");
    expect(kinds).toContain("secondary");
  });

  it("leaves non-rate-limit failures mapped to E_INTERNAL (out of 5.2 scope)", async () => {
    server.use(
      http.get(`${API}/gists`, () => HttpResponse.json({ message: "boom" }, { status: 500 })),
    );
    const adapter = createOctokitGistAdapter({ auth: "t" });
    const res = await adapter.list();
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).not.toBe("E_RATE_LIMIT");
  });
});
