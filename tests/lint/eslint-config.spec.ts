import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint();
});

async function lintMessages(text: string, filePath: string) {
  const results = await eslint.lintText(text, { filePath });
  return results[0]?.messages ?? [];
}

function ruleFired(messages: Array<{ ruleId?: string | null }>, ruleId: string): boolean {
  return messages.some((m) => m.ruleId === ruleId);
}

describe("ESLint base rules (task 1.2)", () => {
  it("forbids the explicit `any` type", async () => {
    const msgs = await lintMessages(
      "export const bad = (x: any): any => x;\n",
      "src/core/some-service.ts",
    );
    expect(ruleFired(msgs, "@typescript-eslint/no-explicit-any")).toBe(true);
  });

  it("enforces import ordering", async () => {
    const src =
      'import foo from "./local-thing";\n' +
      'import path from "node:path";\n\n' +
      "export const x = foo + path.sep;\n";
    const msgs = await lintMessages(src, "src/bootstrap/compose.ts");
    expect(ruleFired(msgs, "import/order")).toBe(true);
  });
});

describe("ESLint layer boundaries — core (task 1.2)", () => {
  it("blocks @modelcontextprotocol/sdk imports from core", async () => {
    const msgs = await lintMessages(
      'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n',
      "src/core/publish-service.ts",
    );
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(true);
  });

  it("blocks @octokit/* imports from core", async () => {
    const msgs = await lintMessages(
      'import { Octokit } from "@octokit/rest";\n',
      "src/core/sync-service.ts",
    );
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(true);
  });

  it("blocks direct adapter imports from core", async () => {
    const msgs = await lintMessages(
      'import { OctokitAdapter } from "../adapters/octokit-adapter.js";\n',
      "src/core/sync-service.ts",
    );
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(true);
  });

  it("blocks pino imports from core", async () => {
    const msgs = await lintMessages('import pino from "pino";\n', "src/core/workspace-service.ts");
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(true);
  });

  it("allows shared/port imports from core", async () => {
    const src =
      'import type { Result } from "../shared/result.js";\n\n' +
      "export const x: Result<number, Error> = { ok: true, value: 1 };\n";
    const msgs = await lintMessages(src, "src/core/sync-service.ts");
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(false);
  });
});

describe("ESLint layer boundaries — facade (task 1.2)", () => {
  it("blocks direct adapter imports from facade", async () => {
    const msgs = await lintMessages(
      'import { OctokitAdapter } from "../adapters/octokit-adapter.js";\n',
      "src/facade/mcp-tool-facade.ts",
    );
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(true);
  });

  it("blocks @octokit/* imports from facade", async () => {
    const msgs = await lintMessages(
      'import { Octokit } from "@octokit/rest";\n',
      "src/facade/mcp-tool-facade.ts",
    );
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(true);
  });

  it("allows @modelcontextprotocol/sdk imports from facade", async () => {
    const src =
      'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n\n' +
      "export const server = Server;\n";
    const msgs = await lintMessages(src, "src/facade/mcp-tool-facade.ts");
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(false);
  });
});

describe("ESLint layer boundaries — adapters/bootstrap (task 1.2)", () => {
  it("allows adapter files to import Octokit", async () => {
    const src =
      'import { Octokit } from "@octokit/rest";\n\n' + "export const client = new Octokit();\n";
    const msgs = await lintMessages(src, "src/adapters/octokit-adapter.ts");
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(false);
  });

  it("allows adapter files to import pino", async () => {
    const src =
      'import pino from "pino";\n\n' + 'export const logger = pino({ name: "gistjet" });\n';
    const msgs = await lintMessages(src, "src/adapters/pino-logger.ts");
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(false);
  });

  it("allows bootstrap to wire adapters", async () => {
    const src =
      'import { OctokitAdapter } from "../adapters/octokit-adapter.js";\n' +
      'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n\n' +
      "export const wire = () => ({ OctokitAdapter, Server });\n";
    const msgs = await lintMessages(src, "src/bootstrap/compose.ts");
    expect(ruleFired(msgs, "no-restricted-imports")).toBe(false);
  });
});
