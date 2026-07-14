/**
 * Backup-file discovery on disk — ONE definition of "a backup file" and how to list them, shared by
 * the CLI's read commands, `restora status` history, the MCP server, and the desktop service.
 * (Extracted from cli/src/mcp.ts during the node-api split; logic unchanged.)
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export function isBackupFileName(name: string): boolean {
  const n = name.toLowerCase();
  if (!n.endsWith(".json")) return false;
  if (n.startsWith("restore-map-")) return false;
  if (n === "seed-output.json" || n === "restore-output.json") return false;
  return n.startsWith("notion-backup-") || n.startsWith("backup-");
}

/** List matching files across roots, newest-first. */
export async function listFiles(
  roots: string[],
  match: (name: string) => boolean,
): Promise<Array<{ path: string; mtimeMs: number; size: number }>> {
  const seen = new Set<string>();
  const out: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue; // missing dir → treat as empty
    }
    for (const name of names) {
      if (!match(name)) continue;
      const path = join(root, name);
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        const s = await stat(path);
        if (s.isFile()) out.push({ path, mtimeMs: s.mtimeMs, size: s.size });
      } catch {
        /* unreadable → skip */
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
