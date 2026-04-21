import { describe, expect, it, vi } from "vitest";

import {
  createAuthService,
  MVP_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from "../../src/core/auth-service";
import { createRedactor } from "../../src/core/redactor";
import type { GhError, GitHubGistPort } from "../../src/shared/ports/github-gist";
import type { Logger } from "../../src/shared/ports/logger";
import { err, isErr, isOk, ok } from "../../src/shared/result";

type ProbeReturn = Awaited<ReturnType<GitHubGistPort["probeGistAccess"]>>;

function createFakePort(probe: () => Promise<ProbeReturn>): GitHubGistPort {
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented in test");
  };
  return {
    create: notImplemented,
    update: notImplemented,
    get: notImplemented,
    list: notImplemented,
    delete: notImplemented,
    fetchRaw: notImplemented,
    probeGistAccess: probe,
  };
}

type LogEntry = {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly event: string;
  readonly payload?: Record<string, unknown>;
};

function createSpyLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const make = (bindings: Record<string, unknown> = {}): Logger => ({
    child: (extra) => make({ ...bindings, ...extra }),
    debug: (event, payload) =>
      entries.push({ level: "debug", event, payload: { ...bindings, ...payload } }),
    info: (event, payload) =>
      entries.push({ level: "info", event, payload: { ...bindings, ...payload } }),
    warn: (event, payload) =>
      entries.push({ level: "warn", event, payload: { ...bindings, ...payload } }),
    error: (event, payload) =>
      entries.push({ level: "error", event, payload: { ...bindings, ...payload } }),
  });
  return { logger: make(), entries };
}

describe("AuthService.resolve (task 6.1)", () => {
  it("prefers GISTJET_GITHUB_TOKEN when both variables are set", () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    const result = auth.resolve({
      GISTJET_GITHUB_TOKEN: "primary-token-value",
      GITHUB_TOKEN: "fallback-token-value",
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).not.toBeNull();
    expect(String(result.value)).toBe("primary-token-value");
  });

  it("falls back to GITHUB_TOKEN when GISTJET_GITHUB_TOKEN is absent", () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    const result = auth.resolve({ GITHUB_TOKEN: "fallback-token-value" });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(String(result.value)).toBe("fallback-token-value");
  });

  it("returns null when neither environment variable is set", () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    const result = auth.resolve({});
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value).toBeNull();
  });

  it("treats empty-string tokens as unset and falls back accordingly", () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    const result = auth.resolve({
      GISTJET_GITHUB_TOKEN: "",
      GITHUB_TOKEN: "fallback-token-value",
    });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(String(result.value)).toBe("fallback-token-value");
  });

  it("trims surrounding whitespace before treating the value as a token", () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    const result = auth.resolve({ GISTJET_GITHUB_TOKEN: "  padded-token-value  " });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(String(result.value)).toBe("padded-token-value");
  });

  it("registers the resolved token with the redactor (so subsequent log lines are masked)", () => {
    const redactor = createRedactor();
    const registerSpy = vi.spyOn(redactor, "registerTokenValue");
    const auth = createAuthService({
      redactor,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    auth.resolve({ GISTJET_GITHUB_TOKEN: "super-secret-token-value" });
    expect(registerSpy).toHaveBeenCalledWith("super-secret-token-value");
  });

  it("registers the token with the redactor before producing any log line", () => {
    const redactor = createRedactor();
    const callOrder: string[] = [];
    vi.spyOn(redactor, "registerTokenValue").mockImplementation(() => {
      callOrder.push("register");
    });
    const { logger } = createSpyLogger();
    const spyLogger: Logger = {
      child: () => spyLogger,
      debug: () => callOrder.push("log"),
      info: () => callOrder.push("log"),
      warn: () => callOrder.push("log"),
      error: () => callOrder.push("log"),
    };
    void logger;
    const auth = createAuthService({
      redactor,
      logger: spyLogger,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    auth.resolve({ GISTJET_GITHUB_TOKEN: "super-secret-token-value" });
    const firstRegisterIdx = callOrder.indexOf("register");
    const firstLogIdx = callOrder.indexOf("log");
    expect(firstRegisterIdx).toBeGreaterThanOrEqual(0);
    if (firstLogIdx !== -1) {
      expect(firstRegisterIdx).toBeLessThan(firstLogIdx);
    }
  });

  it("does not register with the redactor when no token is configured", () => {
    const redactor = createRedactor();
    const registerSpy = vi.spyOn(redactor, "registerTokenValue");
    const auth = createAuthService({
      redactor,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    auth.resolve({});
    expect(registerSpy).not.toHaveBeenCalled();
  });
});

describe("AuthService.verifyAccess (task 6.2)", () => {
  it("classifies token as classic when the probe returns an x-oauth-scopes header", async () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () =>
        createFakePort(async () => ok({ login: "octocat", scopesHeader: "gist, repo" })),
    });
    const res = await auth.verifyAccess("token-value" as never);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.login).toBe("octocat");
    expect(res.value.tokenKind).toBe("classic");
    expect(res.value.scopesReported).toEqual(["gist", "repo"]);
  });

  it("classifies token as fine_grained when the probe omits x-oauth-scopes", async () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () => createFakePort(async () => ok({ login: "finelady", scopesHeader: null })),
    });
    const res = await auth.verifyAccess("token-value" as never);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.login).toBe("finelady");
    expect(res.value.tokenKind).toBe("fine_grained");
    expect(res.value.scopesReported).toBeNull();
  });

  it("parses a single-scope classic header without extra whitespace", async () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () => createFakePort(async () => ok({ login: "u", scopesHeader: "gist" })),
    });
    const res = await auth.verifyAccess("t" as never);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.scopesReported).toEqual(["gist"]);
  });

  it("maps probe E_AUTH invalid_token to AuthError invalid_token", async () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () =>
        createFakePort(async () => err<GhError>({ code: "E_AUTH", detail: "invalid_token" })),
    });
    const res = await auth.verifyAccess("bad" as never);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("E_AUTH");
    if (res.error.code === "E_AUTH") {
      expect(res.error.detail).toBe("invalid_token");
    }
  });

  it("maps probe E_AUTH missing_permission to AuthError missing_permission", async () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () =>
        createFakePort(async () => err<GhError>({ code: "E_AUTH", detail: "missing_permission" })),
    });
    const res = await auth.verifyAccess("t" as never);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("E_AUTH");
    if (res.error.code === "E_AUTH") {
      expect(res.error.detail).toBe("missing_permission");
    }
  });

  it("passes rate-limit errors through with the reset timestamp", async () => {
    const redactor = createRedactor();
    const resetAt = "2026-04-17T21:00:00.000Z";
    const auth = createAuthService({
      redactor,
      portFactory: () =>
        createFakePort(async () => err<GhError>({ code: "E_RATE_LIMIT", resetAt })),
    });
    const res = await auth.verifyAccess("t" as never);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("E_RATE_LIMIT");
    if (res.error.code === "E_RATE_LIMIT") {
      expect(res.error.resetAt).toBe(resetAt);
    }
  });

  it("maps transport/internal failures to AuthError network", async () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () =>
        createFakePort(async () => err<GhError>({ code: "E_INTERNAL", cause: "fetch failed" })),
    });
    const res = await auth.verifyAccess("t" as never);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("E_AUTH");
    if (res.error.code === "E_AUTH") {
      expect(res.error.detail).toBe("network");
    }
  });

  it("emits an auth.verified structured log entry on success", async () => {
    const redactor = createRedactor();
    const { logger, entries } = createSpyLogger();
    const auth = createAuthService({
      redactor,
      logger,
      portFactory: () => createFakePort(async () => ok({ login: "octocat", scopesHeader: "gist" })),
    });
    await auth.verifyAccess("t" as never);
    const success = entries.find((e) => e.event === "auth.verified");
    expect(success).toBeDefined();
    expect(success?.payload?.login).toBe("octocat");
    expect(success?.payload?.token_kind).toBe("classic");
  });

  it("emits an auth.failed structured log entry on mapped failure", async () => {
    const redactor = createRedactor();
    const { logger, entries } = createSpyLogger();
    const auth = createAuthService({
      redactor,
      logger,
      portFactory: () =>
        createFakePort(async () => err<GhError>({ code: "E_AUTH", detail: "missing_permission" })),
    });
    await auth.verifyAccess("t" as never);
    const failure = entries.find((e) => e.event === "auth.failed");
    expect(failure).toBeDefined();
    expect(failure?.payload?.detail).toBe("missing_permission");
  });
});

describe("AuthService.toolSurface (task 6.3)", () => {
  it("exposes the full MVP tool set when a token is configured", () => {
    const redactor = createRedactor();
    const { logger, entries } = createSpyLogger();
    const auth = createAuthService({
      redactor,
      logger,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    const surface = auth.toolSurface({ hasToken: true });
    expect(surface.available.slice().sort()).toEqual(MVP_TOOL_NAMES.slice().sort());
    expect(surface.disabled).toEqual([]);
    expect(entries.filter((e) => e.event === "auth.readonly_mode")).toHaveLength(0);
  });

  it("restricts to read-only tools when no token is configured", () => {
    const redactor = createRedactor();
    const { logger, entries } = createSpyLogger();
    const auth = createAuthService({
      redactor,
      logger,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    const surface = auth.toolSurface({ hasToken: false });
    expect(surface.available.slice().sort()).toEqual(READ_ONLY_TOOL_NAMES.slice().sort());
    expect(surface.disabled.slice().sort()).toEqual(WRITE_TOOL_NAMES.slice().sort());
    const event = entries.find((e) => e.event === "auth.readonly_mode");
    expect(event).toBeDefined();
    expect(event?.level).toBe("info");
    expect(event?.payload?.disabled_tools).toEqual(WRITE_TOOL_NAMES);
  });

  it("omits every write tool from the read-only surface", () => {
    const redactor = createRedactor();
    const auth = createAuthService({
      redactor,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    const surface = auth.toolSurface({ hasToken: false });
    for (const tool of WRITE_TOOL_NAMES) {
      expect(surface.available).not.toContain(tool);
    }
  });

  it("logs the read-only event exactly once even when toolSurface is called repeatedly", () => {
    const redactor = createRedactor();
    const { logger, entries } = createSpyLogger();
    const auth = createAuthService({
      redactor,
      logger,
      portFactory: () => createFakePort(async () => ok({ login: "x", scopesHeader: null })),
    });
    auth.toolSurface({ hasToken: false });
    auth.toolSurface({ hasToken: false });
    const matches = entries.filter((e) => e.event === "auth.readonly_mode");
    expect(matches).toHaveLength(1);
  });
});
