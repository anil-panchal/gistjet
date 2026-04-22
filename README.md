# GistJet

**Local-workspace-aware MCP server that publishes and syncs files to GitHub Gists over stdio.**

GistJet is a [Model Context Protocol](https://modelcontextprotocol.io/) server that lets an AI agent safely publish local files or buffers to GitHub Gists and keep them in sync — with a persistent local-path ↔ gist mapping stored in `.gistjet.json`, diff-aware sync, conflict resolution, and pre-publish secret scanning.

It is not a general-purpose gist client. It is a **safe local-scratch publishing layer for AI agents**, designed so an agent can hand you a gist URL without accidentally leaking secrets, clobbering local work, or making a private scratchpad public.

---

## Table of contents

- [Why GistJet](#why-gistjet)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Quick start](#quick-start)
  - [Claude Desktop](#claude-desktop)
  - [Claude Code](#claude-code)
  - [Cursor](#cursor)
- [MCP tools](#mcp-tools)
  - [init_workspace](#init_workspace)
  - [publish_path_to_gist](#publish_path_to_gist)
  - [publish_selection_to_gist](#publish_selection_to_gist)
  - [sync_path_to_gist](#sync_path_to_gist)
  - [sync_status](#sync_status)
  - [list_gists](#list_gists)
  - [open_gist](#open_gist)
  - [unlink_mapping](#unlink_mapping)
- [Workspace file (`.gistjet.json`)](#workspace-file-gistjetjson)
- [Safety model](#safety-model)
- [Development](#development)
- [Project layout](#project-layout)
- [License](#license)

---

## Why GistJet

Existing tools (GitHub's official MCP server, `gh gist`, GistPad, IDE plugins) cover gist CRUD. They don't give an agent:

1. **A mapped workspace model.** `.gistjet.json` is the source of truth for which local paths map to which gists, with per-file hashes and revisions.
2. **Diff-first, conflict-aware sync.** Every sync computes a plan (`added` / `modified` / `deleted`) and refuses to silently overwrite a diverged mapping.
3. **Safety by default.** Gists are `secret` unless you explicitly opt in with `confirm_public: true`. A pre-publish secret scanner blocks high-confidence matches (API keys, tokens, private keys) before anything leaves your machine.
4. **Resources first, tools second.** MCP resources expose workspace state read-only, so an agent can reason about what's mapped before it acts.

## Features

- **Publish** a file, a folder (multi-file gist), or an in-memory buffer.
- **Sync** with `push` (local → remote) or `pull` (remote → local, gated behind an explicit confirmation).
- **Status** classification: `in_sync`, `local_ahead`, `remote_ahead`, `diverged`, `orphaned`, `local_missing`, with optional unified diffs.
- **Browse** your gists with pagination and filter, and open one's contents (binary files opt-in via `include_binary`).
- **Unlink** mappings, optionally deleting the remote gist (requires double confirmation).
- **Ignore engine** honoring `.gitignore` plus workspace-level patterns, with hardened rules for `.env*`, `.git/`, and similar on pull.
- **Secret scanner** with high / medium / low confidence tiers — high-confidence findings are always blocking; medium and low can be acknowledged per call.
- **Visibility guard** — `public` publishes require `confirm_public: true` in the same call.
- **Local-overwrite gate** — any remote-to-local write requires `confirm_overwrite_local: true`.
- **Atomic writes** with crash-safety for the workspace file.
- **Structured logging** via [pino](https://getpino.io/) with secret redaction.
- **GitHub API throttling** via `@octokit/plugin-throttling`.

## Requirements

- **Node.js ≥ 20** (see [`.nvmrc`](./.nvmrc))
- A **GitHub Personal Access Token** with the `gist` scope ([create one](https://github.com/settings/tokens))

## Installation

### No install (recommended)

Run GistJet directly with `npx` — no cloning or global install required:

```bash
npx -y gistjet
```

This downloads and caches the latest published version on first invocation. Ready-to-copy MCP host configurations are in the [Quick start](#quick-start) section below.

### Global install

```bash
npm install -g gistjet
gistjet        # starts the MCP server on stdio
```

### From source

```bash
git clone <your-repo-url> gistjet
cd gistjet
npm install
npm run build
```

The build emits an executable at `dist/bin/gistjet.js` with a `#!/usr/bin/env node` shebang.

## Configuration

GistJet reads the following environment variables at startup:

| Variable                 | Required | Default         | Purpose                                                           |
| ------------------------ | :------: | --------------- | ----------------------------------------------------------------- |
| `GISTJET_GITHUB_TOKEN`   |   yes¹   | —               | GitHub PAT with the `gist` scope. Preferred over `GITHUB_TOKEN`.  |
| `GITHUB_TOKEN`           |   yes¹   | —               | Fallback GitHub token if `GISTJET_GITHUB_TOKEN` is not set.       |
| `GISTJET_WORKSPACE_ROOT` |    no    | `process.cwd()` | Absolute path to the workspace root the server should operate on. |
| `GISTJET_LOG_LEVEL`      |    no    | pino default    | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`.     |

¹ One of `GISTJET_GITHUB_TOKEN` or `GITHUB_TOKEN` is required. The token is read from the environment only — it is never persisted in `.gistjet.json`.

## Quick start

### Claude Desktop

Add the following to your Claude Desktop config (`claude_desktop_config.json` on macOS lives at `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gistjet": {
      "command": "npx",
      "args": ["-y", "gistjet"],
      "env": {
        "GISTJET_GITHUB_TOKEN": "ghp_your_token_here",
        "GISTJET_WORKSPACE_ROOT": "/absolute/path/to/your/workspace"
      }
    }
  }
}
```

Restart Claude Desktop. Then ask the agent to call `init_workspace` for the workspace root — after that, `publish_path_to_gist`, `sync_path_to_gist`, and the rest are available.

### Claude Code

```bash
claude mcp add --transport stdio \
  --env GISTJET_GITHUB_TOKEN=ghp_your_token_here \
  --env GISTJET_WORKSPACE_ROOT=/absolute/path/to/your/workspace \
  gistjet -- npx -y gistjet
```

The `--` separator is required — it separates `claude mcp add` flags from the server command.

### Cursor

Create or update `.cursor/mcp.json` (project-scoped) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "gistjet": {
      "command": "npx",
      "args": ["-y", "gistjet"],
      "env": {
        "GISTJET_GITHUB_TOKEN": "ghp_your_token_here",
        "GISTJET_WORKSPACE_ROOT": "/absolute/path/to/your/workspace"
      }
    }
  }
}
```

---

## MCP tools

GistJet registers **eight** tools. All inputs and outputs are validated with [Zod](https://zod.dev/); the authoritative definitions live in [`src/facade/tool-schemas.ts`](./src/facade/tool-schemas.ts).

| Tool                        | Purpose                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| `init_workspace`            | Create `.gistjet.json` and configure the workspace root, scratch dir, and ignore rules.     |
| `publish_path_to_gist`      | Publish a local file or folder as a new gist.                                               |
| `publish_selection_to_gist` | Publish an in-memory buffer as a new gist without touching disk.                            |
| `sync_path_to_gist`         | Sync a mapped local path with its gist (push / pull, with dry-run and conflict strategies). |
| `sync_status`               | Classify one or every mapping without writes; optional per-file diffs.                      |
| `list_gists`                | Paginate the authenticated user's gists with visibility / substring filters.                |
| `open_gist`                 | Fetch a gist's metadata and file contents.                                                  |
| `unlink_mapping`            | Remove a mapping; optionally delete the underlying gist with double confirmation.           |

### `init_workspace`

Initialize a GistJet workspace by creating `.gistjet.json` and, unless `commit_mappings: true`, adding it to `.gitignore`.

**Input**

| Field             | Type      | Required | Description                                                                                                                      |
| ----------------- | --------- | :------: | -------------------------------------------------------------------------------------------------------------------------------- |
| `target_dir`      | `string`  |    ✓     | Absolute or workspace-relative directory where `.gistjet.json` will be created.                                                  |
| `scratch_dir`     | `string`  |          | Default scratch workspace directory recorded in `.gistjet.json`. Defaults to `./scratch/` under the workspace root when omitted. |
| `commit_mappings` | `boolean` |          | When `true`, skip adding `.gistjet.json` to `.gitignore`. Use only when you understand that secret gist URLs are not private.    |

**Output:** `workspace_path`, full `config` object, and a `gitignore` summary (`appended` / `created` / `already_ignored` / `skipped_commit_mappings`).

### `publish_path_to_gist`

Publish a local file or folder as a new GitHub gist, enforcing ignore rules, size limits, secret-scan, and visibility defaults.

**Input**

| Field                  | Type                   | Required | Description                                                                                                                            |
| ---------------------- | ---------------------- | :------: | -------------------------------------------------------------------------------------------------------------------------------------- |
| `path`                 | `string`               |    ✓     | Workspace-relative or absolute path. Folders publish as a multi-file gist with deterministic flattened filenames.                      |
| `description`          | `string`               |          | Optional gist description.                                                                                                             |
| `visibility`           | `"secret" \| "public"` |          | `secret` (default) keeps the gist unlisted. `public` requires `confirm_public: true`.                                                  |
| `confirm_public`       | `boolean`              |          | Must be `true` when `visibility: "public"`. Without it the call is rejected with `E_VISIBILITY_CONFIRM`.                               |
| `acknowledge_findings` | `string[]`             |          | Finding ids to acknowledge so medium- or low-confidence secret-scan matches no longer block. High-confidence findings remain blocking. |
| `allow_binary`         | `boolean`              |          | When `true`, binary files are base64-encoded and uploaded. Without it, binary content is refused with `E_BINARY`.                      |

**Output:** `gist_id`, `html_url`, resolved `visibility`, persisted `mapping`, `ignored_files`, and `warnings`.

### `publish_selection_to_gist`

Publish an in-memory content buffer as a new gist without touching disk.

**Input**

| Field                  | Type       | Required | Description                                                       |
| ---------------------- | ---------- | :------: | ----------------------------------------------------------------- |
| `filename`             | `string`   |    ✓     | Gist-visible filename (no directory separators).                  |
| `content`              | `string`   |    ✓     | Text content to publish. Line endings are normalized to LF.       |
| `description`          | `string`   |          | Optional gist description.                                        |
| `visibility`           | `enum`     |          | `secret` (default) or `public` (requires `confirm_public: true`). |
| `confirm_public`       | `boolean`  |          | Required when publishing publicly.                                |
| `acknowledge_findings` | `string[]` |          | Acknowledge medium- / low-confidence secret-scan findings.        |

**Output:** same shape as `publish_path_to_gist`.

### `sync_path_to_gist`

Sync a mapped local path with its linked gist. Push local changes by default; pull remote into local only with `confirm_overwrite_local: true`.

**Input**

| Field                     | Type                                           | Required | Description                                                                                                                                         |
| ------------------------- | ---------------------------------------------- | :------: | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mapping_id`              | `string`                                       |    ✓¹    | Mapping id to sync. Either `mapping_id` or `path` must be supplied.                                                                                 |
| `path`                    | `string`                                       |    ✓¹    | Workspace-relative path of the mapping to sync.                                                                                                     |
| `dry_run`                 | `boolean`                                      |          | When `true`, compute the plan without writes.                                                                                                       |
| `on_conflict`             | `"prefer_local" \| "prefer_remote" \| "abort"` |          | `abort` (default) returns a conflict report. `prefer_local` overwrites remote. `prefer_remote` pulls remote (subject to `confirm_overwrite_local`). |
| `sync_direction`          | `"push" \| "pull"`                             |          | `push` (default) writes local → remote. `pull` writes remote → local and requires `confirm_overwrite_local: true`.                                  |
| `confirm_overwrite_local` | `boolean`                                      |          | Required to be `true` for any remote → local write path. Without it the call is rejected with `E_LOCAL_OVERWRITE_CONFIRM`.                          |

¹ Exactly one of `mapping_id` or `path` must be set.

**Output:** final `classification`, ordered `plan` of file changes (`added` / `modified` / `deleted`, with optional `previous_filename` on rename), `applied` flag, updated `new_mapping_state`, and `ignored_on_pull` for remote → local writes skipped by hardened ignore rules.

### `sync_status`

Classify one mapping (or every mapping when `mapping_id` is omitted) as `in_sync`, `local_ahead`, `remote_ahead`, `diverged`, `orphaned`, or `local_missing`, without writes.

**Input**

| Field           | Type      | Required | Description                                                                            |
| --------------- | --------- | :------: | -------------------------------------------------------------------------------------- |
| `mapping_id`    | `string`  |          | Optional mapping id. When omitted, returns status for every mapping.                   |
| `include_diffs` | `boolean` |          | When `true`, include per-file unified diffs subject to the configured diff-size limit. |

**Output:** `entries[]` — one status report per mapping with `mapping_id`, `classification`, and per-file `change` kind + optional `diff`.

### `list_gists`

Paginate the authenticated user's gists with optional visibility and substring filters; each item reports whether it is already mapped locally.

**Input**

| Field    | Type                                                             | Required | Description                                                    |
| -------- | ---------------------------------------------------------------- | :------: | -------------------------------------------------------------- |
| `filter` | `{ visibility?: "all" \| "public" \| "secret"; query?: string }` |          | Visibility filter plus a description/filename substring match. |
| `cursor` | `string`                                                         |          | Opaque pagination cursor from a previous `list_gists` call.    |

**Output:** `items[]` (each with `gist_id`, `html_url`, `description`, `public`, `updated_at`, `filenames`, `is_mapped`, optional `mapping_id`) and optional `next_cursor`.

### `open_gist`

Open a remote gist with its metadata and file contents.

**Input**

| Field            | Type      | Required | Description                                                                                               |
| ---------------- | --------- | :------: | --------------------------------------------------------------------------------------------------------- |
| `gist_id`        | `string`  |    ✓     | Id of the remote gist to open.                                                                            |
| `include_binary` | `boolean` |          | When `true`, include binary file contents base64-encoded. Without it, binary files return `null` content. |

**Output:** `gist_id`, `html_url`, `description`, `public`, `updated_at`, `revision`, `files[]` (each with `filename`, `size_bytes`, `truncated`, `content`, `encoding: "utf8" | "base64"`), `is_mapped`, optional `mapping_id`.

### `unlink_mapping`

Remove a mapping from `.gistjet.json`. Optionally delete the remote gist when both `delete_remote_gist: true` and `confirm_delete: true` are set.

**Input**

| Field                | Type      | Required | Description                                                                   |
| -------------------- | --------- | :------: | ----------------------------------------------------------------------------- |
| `mapping_id`         | `string`  |    ✓¹    | Mapping id to unlink.                                                         |
| `gist_id`            | `string`  |    ✓¹    | Alternative: gist id whose mapping should be unlinked.                        |
| `delete_remote_gist` | `boolean` |          | When `true`, also delete the gist on GitHub. Requires `confirm_delete: true`. |
| `confirm_delete`     | `boolean` |          | Must be `true` when `delete_remote_gist: true`.                               |

¹ Exactly one of `mapping_id` or `gist_id` must be set.

**Output:** `removed_mapping` and `deleted_remote` boolean.

---

## Workspace file (`.gistjet.json`)

`.gistjet.json` lives at the workspace root and is the single source of truth for GistJet's local state:

```jsonc
{
  "schema_version": 1,
  "workspace_id": "01HXXX...",
  "scratch_dir": "./scratch/",
  "defaults": {
    "visibility": "secret",
    "description_prefix": "gistjet:",
  },
  "ignore": {
    "workspace_patterns": [".env*", "*.pem"],
    "respect_gitignore": true,
  },
  "mappings": [
    {
      "id": "01HXXX...",
      "local_path": "notes/draft.md",
      "gist_id": "abc123...",
      "kind": "file",
      "visibility": "secret",
      "sync_mode": "manual",
      "status": "active",
      "created_at": "2026-04-20T12:00:00.000Z",
      "last_synced_at": "2026-04-20T12:05:00.000Z",
      "last_remote_revision": "sha-1",
      "last_local_hash": "sha256-...",
      "file_snapshots": [
        {
          "gist_filename": "draft.md",
          "relative_path": "notes/draft.md",
          "size_bytes": 1234,
          "is_binary": false,
          "local_hash": "sha256-...",
        },
      ],
    },
  ],
}
```

By default `.gistjet.json` is added to `.gitignore` on `init_workspace`, because a secret gist URL is not a credential but it is not private either. Opt in to committing it by passing `commit_mappings: true` at init.

## Safety model

GistJet refuses to do something surprising without an explicit in-call confirmation:

| Action                                             | Gate                                                      | Error on refusal            |
| -------------------------------------------------- | --------------------------------------------------------- | --------------------------- |
| Publish as `public`                                | `confirm_public: true`                                    | `E_VISIBILITY_CONFIRM`      |
| Write remote → local (`pull` or `prefer_remote`)   | `confirm_overwrite_local: true`                           | `E_LOCAL_OVERWRITE_CONFIRM` |
| Delete the remote gist on unlink                   | `delete_remote_gist: true` **and** `confirm_delete: true` | call rejected, no deletion  |
| Publish a file containing a high-confidence secret | none — blocking                                           | secret-scan finding         |
| Publish a binary file                              | `allow_binary: true`                                      | `E_BINARY`                  |

Logs are redacted via a dedicated [`redactor`](./src/core/redactor.ts) pass so tokens and secrets never reach stdout or log files.

## Development

```bash
npm install

npm run typecheck         # tsc --noEmit
npm run lint              # eslint .
npm run lint:fix          # eslint . --fix
npm run format            # prettier --write .
npm run format:check      # prettier --check .

npm test                  # vitest run
npm run test:watch        # vitest
npm run test:coverage     # vitest run --coverage

npm run build             # tsup → dist/bin/gistjet.js
```

`npm run prepublishOnly` chains lint → typecheck → test → build, and is enforced before `npm publish`.

Husky + lint-staged run `prettier` and `eslint --fix` on staged TypeScript, and `prettier` on staged JS/JSON/MD/YAML.

## Project layout

```
src/
├── bin/            # Stdio entry point — wires adapters, installs signal handlers
├── facade/         # MCP adapter — tool & resource registration, schemas, bootstrapper
├── core/           # Domain services (publish, sync, status, secret-scan, ignore, etc.)
├── adapters/       # Octokit, filesystem, pino, workspace-store
└── shared/         # Domain types, ports, errors, Result<T,E>

tests/
├── core/           # Per-service specs
├── adapters/       # Per-adapter specs (incl. MSW handlers for GitHub)
├── facade/         # Tool / resource facade + bootstrapper specs
├── e2e/            # Publish, sync, status, visibility flows end-to-end
├── shared/         # Error, ports, Result, value-type specs
├── build/          # Build-smoke and tsup config checks
├── harness/        # MSW + vitest setup
└── lint/ ci/ scaffolding/  # Configuration-level specs
```

## License

[MIT](./LICENSE) © Anil Panchal
