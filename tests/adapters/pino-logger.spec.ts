import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "../../src/adapters/pino-logger";
import { createRedactor } from "../../src/core/redactor";

type Capture = {
  readonly stream: { write(msg: string): void };
  readonly parsed: () => Array<Record<string, unknown>>;
};

function createCapture(): Capture {
  const chunks: string[] = [];
  return {
    stream: {
      write(msg: string): void {
        chunks.push(msg);
      },
    },
    parsed(): Array<Record<string, unknown>> {
      return chunks
        .join("")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

describe("pino-backed logger output (task 3.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("emits JSON lines with level, time, and the structured event name", () => {
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "debug" });
    log.info("startup", { port: "stdio" });
    const rows = cap.parsed();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.level).toBe("info");
    expect(row.event).toBe("startup");
    expect(row.port).toBe("stdio");
    expect(typeof row.time).toBe("number");
  });

  it("never writes to process.stdout across every level", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "debug" });
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e", { cause: "x" });
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(cap.parsed()).toHaveLength(4);
  });

  it("drops entries below the configured level", () => {
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "warn" });
    log.debug("quiet");
    log.info("quiet-too");
    log.warn("loud");
    log.error("louder", {});
    expect(cap.parsed()).toHaveLength(2);
  });
});

describe("pino-backed logger correlation (task 3.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("child() binds fields that appear on every subsequent emit", () => {
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "info" });
    const child = log.child({ request_id: "req-01HX" });
    child.info("tool.start");
    child.info("tool.complete");
    const rows = cap.parsed();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.request_id).toBe("req-01HX");
    }
  });

  it("child() composes across nested calls", () => {
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "info" });
    const outer = log.child({ request_id: "r-1" });
    const inner = outer.child({ mapping_id: "m-1" });
    inner.info("go");
    const row = cap.parsed()[0]!;
    expect(row.request_id).toBe("r-1");
    expect(row.mapping_id).toBe("m-1");
    expect(row.event).toBe("go");
  });

  it("parent loggers do not inherit child bindings", () => {
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "info" });
    const child = log.child({ request_id: "abc" });
    child.info("from-child");
    log.info("from-parent");
    const rows = cap.parsed();
    expect(rows[0]?.request_id).toBe("abc");
    expect(rows[1]?.request_id).toBeUndefined();
  });
});

describe("pino-backed logger level precedence (task 3.1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("falls back to GISTJET_LOG_LEVEL when no level option is supplied", () => {
    vi.stubEnv("GISTJET_LOG_LEVEL", "debug");
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream });
    log.debug("seen");
    expect(cap.parsed()).toHaveLength(1);
  });

  it("options.level overrides GISTJET_LOG_LEVEL", () => {
    vi.stubEnv("GISTJET_LOG_LEVEL", "debug");
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "error" });
    log.debug("dropped");
    log.info("dropped");
    log.error("kept", {});
    expect(cap.parsed()).toHaveLength(1);
  });

  it('defaults to "info" when neither option nor env is set', () => {
    vi.stubEnv("GISTJET_LOG_LEVEL", "");
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream });
    log.debug("dropped");
    log.info("kept");
    expect(cap.parsed()).toHaveLength(1);
  });
});

describe("pino-backed logger + redactor integration (task 3.3)", () => {
  const GHP_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("masks registered token substrings in the emitted payload", () => {
    const redactor = createRedactor({ seedDefaults: false });
    redactor.registerTokenValue(GHP_TOKEN);
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "info", redactor });
    log.info("auth", { token: GHP_TOKEN, note: "ok" });
    const row = cap.parsed()[0]!;
    expect(String(row.token)).not.toContain("ghp_");
    expect(String(row.token)).toContain("[REDACTED");
    expect(row.note).toBe("ok");
  });

  it("masks default-pattern hits in nested payload fields", () => {
    const redactor = createRedactor();
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "info", redactor });
    log.info("event", {
      meta: { key: "AKIAIOSFODNN7EXAMPLE", label: "ok" },
    });
    const row = cap.parsed()[0]!;
    const meta = row.meta as Record<string, unknown>;
    expect(String(meta.key)).not.toContain("AKIA");
    expect(String(meta.key)).toContain("[REDACTED");
    expect(meta.label).toBe("ok");
  });

  it("does not redact when no redactor is supplied (prior behavior preserved)", () => {
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "info" });
    log.info("auth", { token: GHP_TOKEN });
    const row = cap.parsed()[0]!;
    expect(row.token).toBe(GHP_TOKEN);
  });
});

describe("pino-backed logger correlation snapshot (task 3.4)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("emits a deterministic structured sequence with request/mapping correlation and never touches stdout", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const cap = createCapture();
    const log = createLogger({ destination: cap.stream, level: "info" });

    const req = log.child({ request_id: "req-01HXTEST" });
    req.info("tool.invoke", { tool: "publish_path_to_gist" });

    const op = req.child({ mapping_id: "map-1" });
    op.info("mapping.upsert", { status: "active" });
    op.warn("gist.truncated", { file: "big.bin" });

    req.error("tool.complete", { outcome: "ok", duration_ms: 123 });

    const cleaned = cap.parsed().map((row) => {
      const { time: _time, ...rest } = row as { time?: unknown };
      return rest;
    });

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(cleaned).toMatchInlineSnapshot(`
      [
        {
          "event": "tool.invoke",
          "level": "info",
          "request_id": "req-01HXTEST",
          "tool": "publish_path_to_gist",
        },
        {
          "event": "mapping.upsert",
          "level": "info",
          "mapping_id": "map-1",
          "request_id": "req-01HXTEST",
          "status": "active",
        },
        {
          "event": "gist.truncated",
          "file": "big.bin",
          "level": "warn",
          "mapping_id": "map-1",
          "request_id": "req-01HXTEST",
        },
        {
          "duration_ms": 123,
          "event": "tool.complete",
          "level": "error",
          "outcome": "ok",
          "request_id": "req-01HXTEST",
        },
      ]
    `);
  });
});
