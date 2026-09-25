/**
 * Archive-aware id resolution over a parsed backup (format 3) — the ONE place a reader asks "is this id
 * in the backup, and is it a live row, a page, or an archived row?".
 *
 * Layered ON TOP of backup-query's live Resolver, which stays byte-identical: that file is mirrored
 * into restora-mcp (scripts/backup-query-mirror-test.ts), and its maps are what every ordinary live
 * query enumerates — query_database, search, get_page, the workspace map, the summaries. Keeping
 * archived rows out of it keeps all of those live-only by construction.
 *
 * Rules (the reading itself is archive-state.ts):
 *  - a CAPTURED archived row is indexed in `archivedById` only — never in pageById/titleById, never in
 *    a data source's `pages` — and every answer about it says `archived: true`;
 *  - unknown and unavailable partitions contribute no rows: nothing is invented for them;
 *  - an inconsistent partition contributes nothing at all — including one whose archived id is also a
 *    live row, where the id resolves to the live row and the archived copy is not trusted;
 *  - v1/v2 (no section): `archivedById` is empty and every data source reads "unchecked".
 *
 * Pure and portable (no node imports), like everything it builds on.
 */
import type { BackupFile, BackupPage } from "../notion/types.js";
import { buildResolver, type Resolver, type ResolvedPage } from "./backup-query.js";
import { readArchive, type ArchiveView } from "./archive-state.js";

/** A captured archived row, with where it belongs. */
export interface ResolvedArchivedRow {
  page: BackupPage;
  archived: true;
  dataSourceId: string;
  databaseId: string;
  dataSourceName: string;
  dbTitle: string;
}

/** The live Resolver, unchanged, plus the archived rows beside it. */
export interface ArchiveAwareResolver extends Resolver {
  /** The canonical per-data-source answer (archive-state.ts). */
  archive: ArchiveView;
  /** Captured archived rows ONLY, by id. Disjoint from pageById by construction. */
  archivedById: Map<string, ResolvedArchivedRow>;
  /** One data source's captured archived rows — empty unless its state is "captured". */
  archivedPagesOf(dataSourceId: string): BackupPage[];
}

export type IdResolution =
  | { kind: "row"; archived: false; resolved: ResolvedPage }
  | { kind: "page"; archived: false; resolved: ResolvedPage }
  | { kind: "archived"; archived: true; archiveState: "captured"; resolved: ResolvedArchivedRow }
  | { kind: "absent"; archived: false };

export function buildArchiveAwareResolver(backup: BackupFile): ArchiveAwareResolver {
  const live = buildResolver(backup);
  const reading = readArchive(backup); // free for v1/v2 (no section → no pass over rows)
  const archivedById = new Map<string, ResolvedArchivedRow>();
  if (reading.view.section === "valid") {
    for (const db of backup.databases ?? []) {
      const dbTitle = db.title || "Untitled database";
      for (const ds of db.dataSources ?? []) {
        for (const page of reading.archivedPagesOf(ds.id)) {
          archivedById.set(page.id, {
            page,
            archived: true,
            dataSourceId: ds.id,
            databaseId: db.id,
            dataSourceName: ds.name || dbTitle || "Data source",
            dbTitle,
          });
        }
      }
    }
  }
  return { ...live, archive: reading.view, archivedById, archivedPagesOf: (id) => reading.archivedPagesOf(id) };
}

/** Resolve any id against the backup. Live first: an id that is live is never answered as archived. */
export function resolveBackupId(r: ArchiveAwareResolver, id: string): IdResolution {
  const live = r.pageById.get(id);
  if (live) return live.dataSourceId ? { kind: "row", archived: false, resolved: live } : { kind: "page", archived: false, resolved: live };
  const archived = r.archivedById.get(id);
  if (archived) return { kind: "archived", archived: true, archiveState: "captured", resolved: archived };
  return { kind: "absent", archived: false };
}
