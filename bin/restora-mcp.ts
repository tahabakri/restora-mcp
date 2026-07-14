/**
 * Standalone entry for the Restora MCP server.
 *
 * `restora mcp` ships inside the @restora/cli package; this thin wrapper exposes the same server as its
 * own `restora-mcp` binary so it can be listed and run independently. All the real logic lives in
 * cli/src/mcp.ts (read-only, stdio JSON-RPC 2.0, offline by default). See the README.
 */
import { cmdMcp } from "../cli/src/mcp.js";

type Flags = Record<string, string | boolean>;

/** Minimal flag parser (mirrors the CLI): `--file x` / `--dir x` take a value; `--allow-live` etc. are booleans. */
function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

cmdMcp(parseArgs(process.argv.slice(2))).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
