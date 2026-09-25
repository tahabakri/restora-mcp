/**
 * Archived rows (format 3) as the MCP tools present them.
 *
 * Built ONLY on the Restora app's canonical readers — archive-state.ts and archive-query.ts, byte-mirrored
 * from the app — so the MCP never holds a second interpretation of the archive section. It leaves
 * backup-query.ts (byte-mirrored too) untouched: that module's query, search and page renderers take a
 * Resolver, and this module builds the one they should be given.
 *
 *   - A relation to a CAPTURED archived row shows that row's title marked " (archived)" — never
 *     "(not in this backup)".
 *   - A relation to a row that isn't in the backup, in a data source whose archived rows weren't captured
 *     (unknown / unavailable / inconsistent), still says "(not in this backup …)" and names that
 *     limitation. Nothing is invented: no row, no title, no claim it exists.
 *   - Every listing stays live-only: the resolver's page and data-source maps are the live ones, so
 *     query_database and search never list an archived row.
 *   - v1/v2 (no archive section): the resolver IS buildResolver's — output is unchanged.
 */
import type { BackupFile } from "../notion/types.js";
import { getPageMarkdown, type Resolver } from "./backup-query.js";
import { buildArchiveAwareResolver, resolveBackupId, type ArchiveAwareResolver } from "./archive-query.js";
import { summarizeArchive, type ArchiveDataSourceState, type ArchiveSummary } from "./archive-state.js";
import { pageTitle } from "./render-md.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Appended to a captured archived row's title wherever a relation names it. */
export const ARCHIVED_MARK = " (archived)";

type Uncaptured = "unknown" | "unavailable" | "inconsistent";
const UNCAPTURED_RANK: Record<Uncaptured, number> = { unknown: 1, unavailable: 2, inconsistent: 3 };
/** A missing relation target whose data source's archived rows weren't captured — still missing, and why
 *  that can't be ruled out. */
const MISSING_TARGET: Record<Uncaptured, string> = {
  unknown: "(not in this backup; archived rows there weren't confirmed)",
  unavailable: "(not in this backup; archived rows there couldn't be checked)",
  inconsistent: "(not in this backup; archived rows there can't be trusted)",
};

/** What the MCP layer carries for one backup. */
export interface ArchiveDisplay {
  /** The Resolver to hand backup-query's functions: live maps, plus titles for archived rows. */
  resolver: Resolver;
  /** The canonical archive-aware reading (archive-query.ts). */
  aware: ArchiveAwareResolver;
}

export function buildArchiveDisplay(backup: BackupFile): ArchiveDisplay {
  const aware = buildArchiveAwareResolver(backup);
  // v1/v2: nothing to add — the live Resolver as buildResolver builds it.
  if (aware.archive.section === "none") return { resolver: aware, aware };

  const titleById = new Map(aware.titleById);
  for (const [id, row] of aware.archivedById) titleById.set(id, `${pageTitle(row.page.properties ?? {})}${ARCHIVED_MARK}`);

  // Relation targets present nowhere in the backup, whose data source's archived rows weren't captured.
  const presentDs = new Set<string>();
  const dataSourcesOfDb = new Map<string, string[]>();
  for (const db of backup.databases ?? []) {
    const list: string[] = [];
    for (const ds of db.dataSources ?? []) {
      presentDs.add(ds.id);
      list.push(ds.id);
    }
    dataSourcesOfDb.set(db.id, list);
  }
  const uncapturedOf = (relDef: any): Uncaptured | undefined => {
    const dsId = relDef?.relation?.data_source_id;
    const dbId = relDef?.relation?.database_id;
    const candidates = typeof dsId === "string" && presentDs.has(dsId) ? [dsId] : typeof dbId === "string" ? (dataSourcesOfDb.get(dbId) ?? []) : [];
    let worst: Uncaptured | undefined;
    for (const id of candidates) {
      const s = aware.archive.stateOf(id).state;
      if ((s === "unknown" || s === "unavailable" || s === "inconsistent") && (!worst || UNCAPTURED_RANK[s] > UNCAPTURED_RANK[worst])) worst = s;
    }
    return worst;
  };
  const missing = new Map<string, Uncaptured>();
  for (const db of backup.databases ?? []) {
    for (const ds of db.dataSources ?? []) {
      const defs = Object.entries(ds.properties ?? {}).filter(([, d]) => (d as any)?.type === "relation");
      if (!defs.length) continue;
      const state = new Map(defs.map(([name, def]) => [name, uncapturedOf(def)] as const));
      for (const page of [...(ds.pages ?? []), ...aware.archivedPagesOf(ds.id)]) {
        for (const [name, value] of Object.entries(page.properties ?? {})) {
          const s = state.get(name);
          if (!s || (value as any)?.type !== "relation" || !Array.isArray((value as any).relation)) continue;
          for (const ref of (value as any).relation) {
            const id = ref?.id;
            if (typeof id !== "string" || titleById.has(id)) continue;
            const prev = missing.get(id);
            if (!prev || UNCAPTURED_RANK[s] > UNCAPTURED_RANK[prev]) missing.set(id, s);
          }
        }
      }
    }
  }
  for (const [id, s] of missing) titleById.set(id, MISSING_TARGET[s]);

  return { resolver: { ...aware, titleById }, aware };
}

/** get_page for any live row, standalone page or CAPTURED archived row. An archived row's source line
 *  says "(archived row)"; an id that isn't in the backup fails exactly as before. */
export function renderPage(display: ArchiveDisplay, pageId: string, format: "markdown" | "text"): string {
  const hit = resolveBackupId(display.aware, pageId);
  if (hit.kind !== "archived") return getPageMarkdown(display.resolver, pageId, format);
  const a = hit.resolved;
  const label =
    a.dataSourceName && a.dataSourceName !== a.dbTitle
      ? { dbTitle: a.dbTitle, dataSourceName: `${a.dataSourceName} (archived row)` }
      : { dbTitle: `${a.dbTitle} (archived row)`, dataSourceName: "" };
  const one: Resolver = { ...display.resolver, pageById: new Map([[pageId, { page: a.page, dataSourceId: a.dataSourceId, ...label }]]) };
  return getPageMarkdown(one, pageId, format);
}

/** One line an agent can act on, carried wherever a v3 answer mentions archived rows. */
export const ARCHIVE_NOTE =
  'Archived rows are kept apart from each data source\'s rows: query_database and search list live rows only; a relation names a captured archived row with "(archived)", and get_page opens one by id. "unknown" means the backup couldn\'t confirm whether any exist — never zero.';

/** The backup-level archive facts (summarizeArchive) — undefined for v1/v2, whose answers don't change. */
export function archiveSummary(backup: BackupFile, display: ArchiveDisplay): ArchiveSummary | undefined {
  return summarizeArchive(backup, display.aware.archive);
}

/** describe_backup's archive block: the summary plus each data source's state. */
export function describeArchive(backup: BackupFile, display: ArchiveDisplay): Record<string, unknown> | undefined {
  const summary = archiveSummary(backup, display);
  if (!summary) return undefined;
  const dataSources: Array<{ dataSourceId: string; name: string } & ArchiveDataSourceState> = [];
  for (const db of backup.databases ?? []) {
    for (const ds of db.dataSources ?? []) {
      dataSources.push({ dataSourceId: ds.id, name: ds.name || db.title || "Data source", ...display.aware.archive.stateOf(ds.id) });
    }
  }
  return { ...summary, dataSources, note: ARCHIVE_NOTE };
}

/** One data source's archived-row state, for query_database — undefined for v1/v2. */
export function dataSourceArchive(display: ArchiveDisplay, dataSourceId: string): Record<string, unknown> | undefined {
  if (display.aware.archive.section === "none") return undefined;
  return { ...display.aware.archive.stateOf(dataSourceId), note: ARCHIVE_NOTE };
}
