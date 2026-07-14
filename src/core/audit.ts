/**
 * Drift Auditor — a READ-ONLY, metadata-first diff of a backup against the live Notion workspace.
 *
 * It answers "what has my live workspace LOST since this backup?" — deleted/emptied databases, removed
 * properties, property-type changes — to drive the (paid) restore. It NEVER writes to Notion and never
 * edits live data.
 *
 * Performance is the whole design: a full row download (Notion pages at 100/req, ~2.5 req/s) would be
 * hundreds of calls and minutes of wall-clock for a big backup. So per data source we do only ~2 cheap
 * calls — getDataSource (existence + schema) and ONE bounded 1-row probe (presence) — never a full
 * pagination. Exact row/relation-value deltas are intentionally out of scope.
 *
 * NOT detected: deleted VIEWS. Notion's public Views REST API does not reflect a UI view deletion —
 * /v1/views keeps listing the view and getView(id) keeps returning it live (no 404, no in_trash), even
 * though the UI hides it. There is no public field to read deletion from, so we deliberately make no
 * "missing views" claim rather than ship one that always reports zero. (MCP/UI use an internal API we
 * don't have.) Revisit if Notion exposes view trash state. See git history for the diagnostic that proved this.
 */
import type { NotionClient } from "../notion/client.js";
import type { BackupFile, BackupDataSource } from "../notion/types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PropertyDrift {
  name: string;
  backupType: string;
  liveType: string; // the live type it changed to
}

/** A property kept (same Notion id) but renamed between backup and live. `liveType` set only when the
 *  type ALSO changed. A rename loses no data — it never flips a database to "drift". */
export interface PropertyRename {
  from: string; // name in the backup
  to: string; // name in the live workspace
  backupType?: string;
  liveType?: string;
}

/** A relation property whose target database/data-source changed. Detected from the relation config
 *  (data_source_id / database_id); also not a data loss on its own. */
export interface RelationRetarget {
  name: string;
  fromTargetId?: string;
  toTargetId?: string;
}

export type AuditStatus = "deleted" | "no-access" | "emptied" | "drift" | "in-sync" | "error";

export interface AuditEntry {
  dbTitle: string;
  dsName: string;
  status: AuditStatus;
  /** Properties present in the backup but gone from the live schema. */
  propsRemovedLive: string[];
  /** Properties added to the live schema since the backup (won't be touched by a restore). */
  propsAddedLive: string[];
  /** Properties whose type changed between backup and live (e.g. Select → Text). */
  propsTypeChanged: PropertyDrift[];
  /** Properties kept but renamed (matched by Notion property id). Not a loss. */
  propsRenamed: PropertyRename[];
  /** Relation properties whose target database changed. Not a loss. */
  propsRelationChanged: RelationRetarget[];
  backupPages: number;
  liveHasRows: boolean | null; // null if unknown or nothing to compare
  note?: string;
}

export interface AuditSummary {
  dataSources: number; // audited (after cap)
  deleted: number;
  emptied: number;
  drifted: number;
  inSync: number;
  truncated: boolean; // backup had more data sources than the cap
  totalInBackup: number;
}

export interface AuditReport {
  entries: AuditEntry[];
  summary: AuditSummary;
}

export interface AuditOptions {
  onProgress?: (event: unknown) => void;
  /** Cap on data sources audited in one run (keeps the call budget + wall-clock bounded). */
  maxDataSources?: number;
  /** Restore-rehearsal mode: backup data-source id → restored (live) data-source id. When set, live
   *  reads target the remapped id — so the audit verifies the RESTORED COPY instead of reporting the
   *  whole backup "deleted" (restored objects have fresh ids). Relation retargets that exactly follow
   *  the remap are expected and suppressed. From RestoreSummary.databases[].dataSources[{oldId,newId}];
   *  nothing is stored server-side. */
  idRemap?: Record<string, string>;
}

const DEFAULT_MAX_DATA_SOURCES = 25;

/** A relation property's target id (data source preferred, else database). */
function relationTarget(prop: any): string | undefined {
  return prop?.relation?.data_source_id ?? prop?.relation?.database_id ?? undefined;
}

/**
 * Compare two Notion property maps → removed / added / type-changed / RENAMED / relation-retargeted.
 * Renames are detected by Notion property `id` (same id, different name), which is reliable because the
 * stored backup keeps the raw property objects (they carry `.id`); if either side lacks an id we fall
 * back to name-matching and make NO rename claim. A renamed property is NOT also reported as
 * removed+added. Pure, single pass.
 */
export function compareSchema(
  backupProps: Record<string, any>,
  liveProps: Record<string, any>,
): {
  propsRemovedLive: string[];
  propsAddedLive: string[];
  propsTypeChanged: PropertyDrift[];
  propsRenamed: PropertyRename[];
  propsRelationChanged: RelationRetarget[];
} {
  const bp = backupProps ?? {};
  const lp = liveProps ?? {};
  const propsRemovedLive: string[] = [];
  const propsAddedLive: string[] = [];
  const propsTypeChanged: PropertyDrift[] = [];
  const propsRenamed: PropertyRename[] = [];
  const propsRelationChanged: RelationRetarget[] = [];

  // Index live props by id for reliable rename detection (skip any without an id).
  const liveById = new Map<string, { name: string; prop: any }>();
  for (const [name, prop] of Object.entries(lp)) {
    if (typeof prop?.id === "string") liveById.set(prop.id, { name, prop });
  }
  const matchedLiveIds = new Set<string>();
  const usedLiveNames = new Set<string>(); // live names consumed by an id/name match (so not "added")

  const checkRetarget = (name: string, bProp: any, lProp: any): void => {
    if (bProp?.type === "relation" && lProp?.type === "relation") {
      const from = relationTarget(bProp);
      const to = relationTarget(lProp);
      if (from && to && from !== to) propsRelationChanged.push({ name, fromTargetId: from, toTargetId: to });
    }
  };

  for (const [name, prop] of Object.entries(bp)) {
    const id = typeof prop?.id === "string" ? prop.id : undefined;
    const byId = id ? liveById.get(id) : undefined;
    if (byId) {
      matchedLiveIds.add(id!);
      usedLiveNames.add(byId.name);
      const typeChanged = !!(prop?.type && byId.prop?.type && prop.type !== byId.prop.type);
      if (byId.name !== name) {
        propsRenamed.push({ from: name, to: byId.name, backupType: prop?.type, liveType: typeChanged ? byId.prop?.type : undefined });
      } else if (typeChanged) {
        propsTypeChanged.push({ name, backupType: prop.type, liveType: byId.prop.type });
      }
      checkRetarget(byId.name, prop, byId.prop);
      continue;
    }
    // No id match → name-match fallback (original behavior; never claims a rename).
    const live = lp[name];
    if (!live) {
      propsRemovedLive.push(name);
    } else {
      usedLiveNames.add(name);
      if (prop?.type && live?.type && prop.type !== live.type) {
        propsTypeChanged.push({ name, backupType: prop.type, liveType: live.type });
      }
      checkRetarget(name, prop, live);
    }
  }

  for (const [name, prop] of Object.entries(lp)) {
    if (typeof prop?.id === "string" && matchedLiveIds.has(prop.id)) continue;
    if (usedLiveNames.has(name)) continue;
    propsAddedLive.push(name);
  }

  return { propsRemovedLive, propsAddedLive, propsTypeChanged, propsRenamed, propsRelationChanged };
}

function baseEntry(dbTitle: string, dsName: string, backupPages: number): AuditEntry {
  return {
    dbTitle,
    dsName,
    status: "in-sync",
    propsRemovedLive: [],
    propsAddedLive: [],
    propsTypeChanged: [],
    propsRenamed: [],
    propsRelationChanged: [],
    backupPages,
    liveHasRows: null,
  };
}

export async function runAudit(
  notion: NotionClient,
  backup: BackupFile,
  opts: AuditOptions = {},
): Promise<AuditReport> {
  const onProgress = opts.onProgress ?? (() => {});
  const cap = Math.max(1, opts.maxDataSources ?? DEFAULT_MAX_DATA_SOURCES);
  const remap = opts.idRemap ?? {};

  // Flatten databases → data sources, keeping the owning database's title for display.
  const all: Array<{ dbTitle: string; ds: BackupDataSource }> = [];
  for (const db of backup.databases ?? []) {
    for (const ds of db.dataSources ?? []) {
      all.push({ dbTitle: db.title || "Untitled database", ds });
    }
  }
  const totalInBackup = all.length;
  const slice = all.slice(0, cap);
  const truncated = totalInBackup > slice.length;

  onProgress({
    type: "phase",
    phase: `Comparing ${slice.length} data source${slice.length === 1 ? "" : "s"} to your live workspace`,
  });
  if (truncated) {
    onProgress({
      type: "warn",
      message: `Auditing the first ${slice.length} of ${totalInBackup} data sources (cap) — the biggest signals first.`,
    });
  }

  const entries: AuditEntry[] = [];
  for (let i = 0; i < slice.length; i++) {
    const { dbTitle, ds } = slice[i]!;
    const dsName = ds.name || dbTitle;
    const label = ds.name && ds.name !== dbTitle ? `${dbTitle} · ${ds.name}` : dbTitle;
    onProgress({ type: "info", message: `Auditing ${label} (${i + 1}/${slice.length})` });

    const backupProps = (ds.properties ?? {}) as Record<string, any>;
    const backupPages = Array.isArray(ds.pages) ? ds.pages.length : 0;

    // 1. Existence + schema (one call). In rehearsal mode the live copy has a fresh id — follow the remap.
    const liveId = remap[ds.id] ?? ds.id;
    let live: any;
    try {
      live = await notion.getDataSource(liveId);
    } catch (err) {
      const code = (err as any)?.code;
      const status = (err as any)?.status;
      const entry = baseEntry(dbTitle, dsName, backupPages);
      if (code === "object_not_found" || status === 404) {
        entries.push({ ...entry, status: "deleted", note: "Gone from your workspace — a restore rebuilds it." });
      } else if (code === "restricted_resource" || status === 403 || status === 401) {
        entries.push({ ...entry, status: "no-access", note: "Restora no longer has access to this database." });
      } else {
        entries.push({ ...entry, status: "error", note: (err as Error)?.message ?? "Couldn't read this database." });
      }
      continue;
    }

    // Notion returns trashed objects without a 404 — treat in_trash as deleted.
    if (live?.in_trash === true) {
      entries.push({ ...baseEntry(dbTitle, dsName, backupPages), status: "deleted" });
      continue;
    }

    const schema = compareSchema(backupProps, (live?.properties ?? {}) as Record<string, any>);
    // A relation that now points at the restored copy of its old target isn't a retarget — it's the
    // restore doing its job. Only meaningful outside rehearsal mode when remap is empty (no-op filter).
    schema.propsRelationChanged = schema.propsRelationChanged.filter(
      (r) => !(r.fromTargetId && r.toTargetId && remap[r.fromTargetId] === r.toTargetId),
    );

    // 2. Row presence (one bounded call) — only worth probing if the backup had rows.
    let liveHasRows: boolean | null = null;
    if (backupPages > 0) {
      try {
        const probe = await notion.queryDataSourceFirstPage(liveId, 1);
        liveHasRows = probe.results.length > 0 || probe.has_more;
      } catch {
        liveHasRows = null;
      }
    }

    const emptied = backupPages > 0 && liveHasRows === false;
    // "drift" = a LOSS the backup can restore (removed props, type changes). Renames, additions, and
    // relation-retargets change the schema but lose no data, so they never flip a database to drift —
    // they're surfaced as informational change rows in the report instead.
    const schemaDrift = schema.propsRemovedLive.length > 0 || schema.propsTypeChanged.length > 0;
    const status: AuditStatus = emptied ? "emptied" : schemaDrift ? "drift" : "in-sync";

    entries.push({
      dbTitle,
      dsName,
      status,
      propsRemovedLive: schema.propsRemovedLive,
      propsAddedLive: schema.propsAddedLive,
      propsTypeChanged: schema.propsTypeChanged,
      propsRenamed: schema.propsRenamed,
      propsRelationChanged: schema.propsRelationChanged,
      backupPages,
      liveHasRows,
    });
  }

  const summary: AuditSummary = {
    dataSources: entries.length,
    deleted: entries.filter((e) => e.status === "deleted").length,
    emptied: entries.filter((e) => e.status === "emptied").length,
    drifted: entries.filter((e) => e.status === "drift").length,
    inSync: entries.filter((e) => e.status === "in-sync").length,
    truncated,
    totalInBackup,
  };

  return { entries, summary };
}
