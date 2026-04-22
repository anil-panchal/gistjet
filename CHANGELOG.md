# Changelog

All notable changes to GistJet are documented here.

Format follows [Keep a Changelog 1.0.0](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning 2.0.0](https://semver.org/):
MAJOR for breaking changes to the MCP tool surface or CLI interface,
MINOR for backward-compatible new features,
PATCH for backward-compatible bug fixes.

## [Unreleased]

## [1.0.0] - 2026-04-22

### Added

- Published to npm as `gistjet`; runnable with `npx -y gistjet` without cloning or building
- `--help` / `-h` flag: prints usage, environment variables, and integration examples then exits 0
- `--version` / `-v` flag: prints the semver version string then exits 0
- TTY banner: when invoked directly in a terminal with no flags, prints an informational message explaining GistJet is an MCP stdio server and exits 0
- `smithery.yaml` for discovery and one-command install via the Smithery MCP registry
- GitHub Actions release workflow (`.github/workflows/release.yml`): triggered on `v*.*.*` tag push, quality-gated (lint → typecheck → test → build), publishes to npm, creates a GitHub Release with auto-generated notes
- Ready-to-copy integration snippets for Claude Desktop, Claude Code (`claude mcp add`), and Cursor in `README.md`
