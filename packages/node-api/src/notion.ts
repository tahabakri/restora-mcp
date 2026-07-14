/** Notion helpers shared by the CLI commands and the setup wizard. */
import { NotionClient, NotionError } from "../../../src/notion/client.js";
import { loadConfig, saveConfig } from "./config.js";

/**
 * The #1 first-run snag: the integration is connected but can see zero databases. The thing users
 * miss is that sharing ONE top-level page cascades to every database nested inside it — they don't
 * have to share databases one by one. Notion's public API has no workspace-wide grant, so this
 * page-sharing step is unavoidable; the least we can do is explain it clearly and identically
 * everywhere it can surface (backup error, `databases`, `connect notion`, `status`).
 */
export const NO_DATABASES_HELP =
  "No databases are shared with your Restora integration yet.\n\n" +
  "  In Notion, share a top-level page with Restora — every database nested\n" +
  "  inside it is picked up automatically (no need to add them one by one):\n\n" +
  "      open the page  →  •••  (top-right)  →  Connections  →  add Restora\n\n" +
  "  Already shared a page but still see this? A linked database can live on a\n" +
  "  different page — share that page too, then run  restora backup  again.";

export function plainText(rich: unknown): string {
  return Array.isArray(rich) ? rich.map((r) => (r as { plain_text?: string }).plain_text ?? "").join("") : "";
}

/** Build a NotionClient from the saved token, or throw a clear "not connected" message. */
export async function clientFromConfig(): Promise<NotionClient> {
  const cfg = await loadConfig();
  if (!cfg.notion?.token) throw new Error("Notion isn't connected. Run: restora setup (or restora connect notion).");
  return new NotionClient(cfg.notion.token);
}

/** Validate a token against Notion (fails loudly on a typo) and save it locally. Returns the workspace name. */
export async function validateAndSaveNotionToken(token: string): Promise<string> {
  let me: { name?: string; bot?: { workspace_name?: string } };
  try {
    me = (await new NotionClient(token).getSelf()) as { name?: string; bot?: { workspace_name?: string } };
  } catch (e) {
    if (e instanceof NotionError && (e.status === 401 || e.code === "unauthorized")) {
      throw new Error(
        'That token wasn\'t accepted by Notion. Copy the Internal Integration Secret (it starts with "ntn_"), with no extra spaces.',
      );
    }
    throw e; // network/5xx/etc. — surface as-is
  }
  const cfg = await loadConfig();
  cfg.notion = { token };
  await saveConfig(cfg);
  return me.bot?.workspace_name ?? me.name ?? "your workspace";
}

/** List databases the integration can see — mirrors the web app's /api/databases discovery exactly. */
export async function listDatabases(
  notion: NotionClient,
): Promise<Array<{ id: string; title: string; dataSourceCount: number }>> {
  const dataSources = await notion.searchAll({ filter: { property: "object", value: "data_source" } });
  const byDb = new Map<string, { id: string; title: string; dataSourceCount: number }>();
  for (const ds of dataSources as Array<Record<string, any>>) {
    // Skip TRASHED databases — Notion's /search returns items in the 30-day trash, which otherwise show
    // as phantom "Untitled" entries the user can't find in their live workspace. (Mirrors discovery.ts.)
    if (ds.in_trash === true || ds.archived === true) continue;
    const dbId: string | undefined = ds.parent?.database_id ?? ds.database_parent?.database_id;
    if (!dbId) continue;
    const existing = byDb.get(dbId);
    if (existing) existing.dataSourceCount++;
    else byDb.set(dbId, { id: dbId, title: plainText(ds.title) || "Untitled", dataSourceCount: 1 });
  }
  return [...byDb.values()];
}
