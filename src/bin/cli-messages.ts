export function formatVersion(version: string): string {
  return `${version}\n`;
}

export function formatHelp(version: string): string {
  return `gistjet ${version}
Local-workspace-aware MCP server that publishes and syncs files to GitHub Gists over stdio.

Usage:
  npx -y gistjet            Start the MCP stdio server (default)
  gistjet --help            Show this help message
  gistjet --version         Print the version and exit

Environment Variables:
  GISTJET_GITHUB_TOKEN      GitHub personal access token (classic with 'gist' scope, or
                            fine-grained with Gist read+write). Required for write tools.
  GITHUB_TOKEN              Fallback token if GISTJET_GITHUB_TOKEN is not set.
  GISTJET_WORKSPACE_ROOT    Absolute path to the workspace directory GistJet should use.
                            Defaults to the current working directory.

Read-only mode: When no token is configured, GistJet starts in read-only mode.
Only list_gists, open_gist, and sync_status are available; write tools are omitted.

Integration Examples:

Claude Desktop (~/.config/Claude/claude_desktop_config.json or
~/Library/Application Support/Claude/claude_desktop_config.json):

  {
    "mcpServers": {
      "gistjet": {
        "command": "npx",
        "args": ["-y", "gistjet"],
        "env": {
          "GISTJET_GITHUB_TOKEN": "<your-token>",
          "GISTJET_WORKSPACE_ROOT": "/path/to/workspace"
        }
      }
    }
  }

Claude Code:

  claude mcp add --transport stdio \\
    --env GISTJET_GITHUB_TOKEN=<your-token> \\
    --env GISTJET_WORKSPACE_ROOT=/path/to/workspace \\
    gistjet -- npx -y gistjet

Cursor (.cursor/mcp.json):

  {
    "mcpServers": {
      "gistjet": {
        "command": "npx",
        "args": ["-y", "gistjet"],
        "env": {
          "GISTJET_GITHUB_TOKEN": "<your-token>",
          "GISTJET_WORKSPACE_ROOT": "/path/to/workspace"
        }
      }
    }
  }

More information: https://github.com/anil-panchal/gistjet
`;
}

export function formatTtyBanner(version: string): string {
  return `gistjet ${version} — MCP stdio server

GistJet is an MCP stdio server and must be launched by an MCP host (Claude Desktop,
Claude Code, Cursor, etc.). Running it directly in a terminal will not start anything useful.

Environment Variables:
  GISTJET_GITHUB_TOKEN      GitHub token (required for write tools)
  GITHUB_TOKEN              Fallback token
  GISTJET_WORKSPACE_ROOT    Workspace directory (optional)

Run gistjet --help for full usage and integration examples.
`;
}
