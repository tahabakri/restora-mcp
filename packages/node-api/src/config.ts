/**
 * Local config for the Restora CLI — the ONLY place credentials live, and they live ONLY on the
 * user's machine. Nothing here is ever sent to a Restora server. File is chmod 0600 (owner-only);
 * on Windows the mode is a no-op and the file relies on the user-profile ACL instead.
 *
 * This is the load-bearing privacy guarantee of the CLI: Notion token + Google refresh token never
 * leave `~/.restora/config.json`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod, rename, rm } from "node:fs/promises";
import type { S3Config } from "./s3.js";

export interface RestoraConfig {
  /** Notion internal-integration token (user-created; non-expiring). Never transmitted to Restora. */
  notion?: { token: string };
  /** Google Drive OAuth tokens (Desktop-app loopback flow, drive.file scope). Local only. */
  google?: { refresh_token: string; access_token?: string; expires_at?: number };
  /** Selected database ids to back up. Empty/undefined ⇒ every database the integration can see. */
  databases?: string[];
  /** Selected standalone-page ids to back up (nav/wiki/dashboard pages). Pages are opt-in — empty/
   *  undefined ⇒ no standalone pages (unlike databases, they are NOT backed up by default). */
  pages?: string[];
  destination?: "drive" | "local" | "s3";
  localDir?: string;
  /** S3-compatible bucket (AWS, Backblaze B2, Cloudflare R2, Wasabi, DO Spaces). Keys are local-only. */
  s3?: S3Config;
  /** Prune old backups after each run: keep the newest `keep`, and/or trash anything older than `weeks`
   *  weeks. The most recent backup is always kept. */
  retention?: { keep?: number; weeks?: number };
  /** Mirror of the OS-scheduled time ("HH:MM" 24h), written by `restora schedule` so `status` can show
   *  the next run. The OS task (schtasks/cron) remains the execution source of truth. */
  schedule?: { daily: string };
  lastBackupAt?: string;
  /** Read-only MCP server settings. `allowLive` enables the network-touching drift-audit tool without
   *  needing the --allow-live flag each run. Defaults off (server is offline-only). */
  mcp?: { allowLive?: boolean };
  /** Latest `restora guard` snapshot (pre-AI-agent safety net). Points at a local notion-guard-*.json;
   *  `guard --report` diffs live-now against it. One guard at a time — a new one replaces this. */
  guard?: { label?: string; path: string; createdAt: string };
}

const DIR = join(homedir(), ".restora");
const FILE = join(DIR, "config.json");

export function configPath(): string {
  return FILE;
}

export async function loadConfig(): Promise<RestoraConfig> {
  let raw: string;
  try {
    raw = await readFile(FILE, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw e;
  }
  try {
    return JSON.parse(raw) as RestoraConfig;
  } catch {
    // Corrupt file (e.g. a process killed mid-write on an older version). Move it aside so the user
    // isn't permanently locked out of every command — they just reconnect.
    const aside = `${FILE}.corrupt-${Date.now()}`;
    await rename(FILE, aside).catch(() => {});
    console.warn(`Warning: ${FILE} was unreadable and was moved to ${aside}. Run \`restora setup\` to reconnect.`);
    return {};
  }
}

export async function saveConfig(cfg: RestoraConfig): Promise<void> {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  // Atomic write: a kill mid-write must never leave a half-written credential file. Write a temp file
  // (owner-only), then rename over the target (atomic on the same filesystem).
  const tmp = `${FILE}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    await rename(tmp, FILE);
  } catch {
    // Windows can refuse rename-over-existing — remove the target first, then rename.
    await rm(FILE, { force: true });
    await rename(tmp, FILE);
  }
  await chmod(FILE, 0o600).catch(() => {}); // no-op / unsupported on Windows; ignore
}
