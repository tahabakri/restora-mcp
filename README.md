# Restora MCP Server

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your local
[Notion](https://notion.so) backups to any MCP-capable AI agent — Claude Desktop, Cursor, Cline, Continue,
Zed, and others. Ask questions about your backed-up workspace, query databases, and read pages, all from
backup files sitting on your own machine.

It's the MCP component of [**Restora**](https://restora.cc) — a Notion backup & restore tool — packaged
here as a standalone, source-available server. The ready-to-run version ships inside
[`@restora/cli`](https://www.npmjs.com/package/@restora/cli) as `restora mcp`.

## Why it's safe

- **Offline by default.** The server makes **zero outbound network calls** in its default mode — every
  answer is read from local backup `.json` files. The only tool that touches the network is
  `run_drift_audit`, and it is *not even registered* unless you pass `--allow-live`. When enabled, it
  talks only to **your own Notion** — never to an LLM, never to Restora's servers.
- **The AI's own model does the reasoning.** This server makes no LLM calls, holds no API key, and sends
  no telemetry.
- **Read-only, structurally.** Every tool is side-effect-free. Because no tool can write, delete, or take
  action in Notion, backup content is treated strictly as *data, not instructions* — a malicious string in
  a backup can at worst mislead output, never cause an action.
- **Path-traversal guarded.** A tool's `path` argument must resolve inside your configured backup folder.

## Tools

| Tool | What it does |
|------|--------------|
| `list_backups` | List your local Restora backup files (path, date, size, database/page counts, and the Notion workspace each came from — compare by id). |
| `describe_backup` | Workspace map of a backup: databases → data sources → property schema, the relations graph, and views. Start here. |
| `query_database` | Rows of one database with readable values — relations resolved to linked page titles. |
| `get_page` | One page's properties and content, rendered to Markdown or plain text. |
| `search` | Find pages by case-insensitive substring across titles, property values, and block text. |
| `read_id_map` | Summarize a restore id-map (`restore-map-*.json`): old → new ids, to repoint integrations after a restore. |
| `run_drift_audit` | *(requires `--allow-live`)* Compare a backup against your **current** Notion to find deleted/emptied databases, removed properties, and type changes. Reads your own Notion only. |

## Quick start (recommended)

The published package is the fastest path — no clone or build. Add this to your agent's MCP config:

```json
{
  "mcpServers": {
    "restora": {
      "command": "npx",
      "args": ["-y", "@restora/cli", "mcp"],
      "env": {}
    }
  }
}
```

Config file locations:

- **Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop (Windows):** `%APPDATA%\Claude\claude_desktop_config.json`
- **Cursor:** `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project)

To enable the live drift-audit tool, add `"--allow-live"` to `args`. Run `npx @restora/cli mcp --print-config`
to print a ready-to-paste config.

## Build from source (this repo)

```bash
npm install
npm run build      # → dist/restora-mcp.js (single self-contained bundle, zero runtime deps)
node dist/restora-mcp.js --print-config
```

Point an agent at the built binary:

```json
{
  "mcpServers": {
    "restora": { "command": "node", "args": ["/absolute/path/to/dist/restora-mcp.js"], "env": {} }
  }
}
```

Flags: `--file <path>` (a specific backup), `--dir <path>` (a backups folder), `--allow-live` (enable
`run_drift_audit`), `--print-config` (print an MCP config and exit).

## Getting backups to read

This server reads Restora backup files. Create some for free with the CLI:

```bash
npx @restora/cli backup --to local
```

or from [restora.cc](https://restora.cc). Backups are plain `.json` — your data stays on your machine.

## License

[MIT](./LICENSE) © Taha Bakri
