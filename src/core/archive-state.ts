/**
 * Archived Notion rows — the ONE reading of a backup's top-level `archive` section (format 3).
 *
 * Nothing WRITES this section yet. This is the reader half, shipped first so that every reader already
 * understands the format before any producer emits it. Every reader asks the same question — "what do
 * we know about the archived rows of this data source?" — through `stateOf(dataSourceId)`:
 *
 *   captured        archived rows were captured (`pages`, at least one)
 *   confirmed_zero  the partition was listed, returned nothing, AND the run proved the archive
 *                   mechanism works in this workspace (it saw an archived row somewhere)
 *   unknown         listed and empty, but nothing proved the mechanism — Notion answers an archived
 *                   query with an empty list both when there are none and when the workspace has no
 *                   Archive, so an empty answer alone is never zero
 *   unavailable     the producer tried and couldn't list it (named reason)
 *   inconsistent    the section or entry is malformed or contradicts the rest of the backup
 *   unchecked       a v1/v2 backup: archived rows were never looked at
 *
 * Nothing here infers zero from absence. Every malformed shape lands on `inconsistent` (per data
 * source), never on `captured` or `confirmed_zero`, and never on a whole-file parse error — the live
 * data stays readable. Pure and portable (no node imports): used by the web, the worker, the server
 * scan and the CLI alike.
 *
 * The approved v3 shape:
 *   archive: {
 *     v: 1,
 *     capability: "proven" | "unproven",
 *     dataSources: [ { databaseId, dataSourceId, state: "captured" | "empty" | "unavailable",
 *                      reason?  (unavailable only), pages? (captured only, ≥1 row) } ],
 *     stateChangedRows?: number   (rows un-archived mid-backup — named, not captured)
 *   }
 * One entry per data source the backup captured live.
 */
import { backupPageSchema, ARCHIVE_FORMAT_VERSION, type BackupFile, type BackupPage } from "../notion/types.js";

export type ArchiveState = "captured" | "confirmed_zero" | "unknown" | "unavailable" | "inconsistent" | "unchecked";

export interface ArchiveDataSourceState {
  state: ArchiveState;
  /** Archived rows captured for this data source ("captured" only). */
  pageCount?: number;
  /** The producer's reason code ("unavailable" only). */
  reason?: string;
  /** Why the entry can't be trusted ("inconsistent" only). Content-free. */
  issue?: string;
}

export interface ArchiveView {
  /** "none": no section (v1/v2 → every data source unchecked). "valid" / "malformed" otherwise. */
  section: "none" | "valid" | "malformed";
  /** Present only on a valid section. */
  capability?: "proven" | "unproven";
  /** Rows un-archived mid-backup (in neither list) — present only when the section says so. */
  stateChangedRows?: number;
  /** Section-level problems, named for any caller that reports them. Content-free. */
  issues: string[];
  /** The canonical per-data-source answer. A data source this backup doesn't contain is "unchecked". */
  stateOf(dataSourceId: string): ArchiveDataSourceState;
}

/** The section's scalar header, judged on its own. */
export interface ArchiveHeaderDigest {
  ok: boolean;
  capability?: "proven" | "unproven";
  stateChangedRows?: number;
  issues: string[];
}

/** A content-free summary of one raw `dataSources[]` entry: enough to judge it without holding its pages. */
export interface ArchiveEntryDigest {
  index: number;
  /** The entry wasn't an object at all. */
  notObject?: boolean;
  databaseId?: unknown;
  dataSourceId?: unknown;
  state?: unknown;
  reason?: unknown;
  /** Whether a `pages` key was present, and whether it was an array. */
  pages: "absent" | "array" | "invalid";
  /** Ids of the pages that passed the page schema, in order. */
  pageIds: string[];
  /** Pages that failed the page schema. */
  invalidPages: number;
}

/** Judge the section's header. `raw` is the whole `archive` value; `dataSources` is looked at only for
 *  its type here (entries are digested separately, so the streaming scan never holds them all). */
export function readArchiveHeader(raw: unknown, dataSourcesIsArray?: boolean): ArchiveHeaderDigest {
  const issues: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, issues: ["the archive section isn't an object"] };
  }
  const s = raw as Record<string, unknown>;
  if (s.v !== 1) issues.push(`unsupported archive section version (${JSON.stringify(s.v ?? null)})`);
  const capability = s.capability === "proven" || s.capability === "unproven" ? s.capability : undefined;
  if (!capability) issues.push("the archive capability is missing or unknown");
  const isArray = dataSourcesIsArray ?? Array.isArray(s.dataSources);
  if (!isArray) issues.push("the archive section has no dataSources list");
  let stateChangedRows: number | undefined;
  if (s.stateChangedRows !== undefined) {
    if (typeof s.stateChangedRows === "number" && Number.isInteger(s.stateChangedRows) && s.stateChangedRows >= 0) {
      stateChangedRows = s.stateChangedRows;
    } else {
      issues.push("stateChangedRows isn't a non-negative whole number");
    }
  }
  return { ok: issues.length === 0, capability, stateChangedRows, issues };
}

/** Digest one raw entry. Each page that passes the page schema is handed to `onPage` (so the in-memory
 *  reader can keep it and the scan can write it to disk), in order. */
export function digestArchiveEntry(raw: unknown, index: number, onPage?: (page: BackupPage) => void): ArchiveEntryDigest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { index, notObject: true, pages: "absent", pageIds: [], invalidPages: 0 };
  }
  const e = raw as Record<string, unknown>;
  const digest: ArchiveEntryDigest = {
    index,
    databaseId: e.databaseId,
    dataSourceId: e.dataSourceId,
    state: e.state,
    reason: e.reason,
    pages: !("pages" in e) ? "absent" : Array.isArray(e.pages) ? "array" : "invalid",
    pageIds: [],
    invalidPages: 0,
  };
  if (digest.pages === "array") {
    for (const p of e.pages as unknown[]) {
      const parsed = backupPageSchema.safeParse(p);
      if (parsed.success) {
        digest.pageIds.push(parsed.data.id);
        onPage?.(parsed.data);
      } else {
        digest.invalidPages++;
      }
    }
  }
  return digest;
}

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * The shared judgment, over digests only — the in-memory reader and the streaming scan both feed it,
 * so a file reads the same way however it was opened.
 *
 * `owners` maps every LIVE data source id in the backup to its database id. `isLive(id)` answers
 * whether an id is also a live row (any data source) or a standalone page — an archived row that is
 * ALSO live is a cross-list conflict.
 */
export function buildArchiveView(input: {
  formatVersion: unknown;
  hasSection: boolean;
  header: ArchiveHeaderDigest | null;
  entries: ArchiveEntryDigest[];
  owners: Map<string, string>;
  isLive: (id: string) => boolean;
}): ArchiveView {
  const { formatVersion, hasSection, header, entries, owners, isLive } = input;
  const unchecked: ArchiveDataSourceState = { state: "unchecked" };

  const malformed = (issues: string[]): ArchiveView => {
    const bad: ArchiveDataSourceState = { state: "inconsistent", issue: "the backup's archive section can't be read" };
    return {
      section: "malformed",
      issues,
      stateOf: (ds) => (owners.has(ds) ? bad : unchecked),
    };
  };

  if (formatVersion !== ARCHIVE_FORMAT_VERSION) {
    // v1/v2: archived rows were never looked at. A section here contradicts the format — refuse it.
    if (!hasSection) return { section: "none", issues: [], stateOf: () => unchecked };
    return malformed([`an archive section in a format-${String(formatVersion)} backup`]);
  }
  if (!hasSection) return malformed(["a format-3 backup without its archive section"]);
  if (!header || !header.ok) return malformed(header?.issues.length ? header.issues : ["the archive section can't be read"]);
  const capability = header.capability!;
  if (capability === "unproven" && entries.some((e) => e.state === "captured")) {
    // A captured row IS an observation of the archive mechanism — "unproven" contradicts it.
    return malformed(['capability is "unproven" but archived rows were captured']);
  }

  const issues: string[] = [];
  const byDs = new Map<string, ArchiveEntryDigest[]>();
  for (const e of entries) {
    if (e.notObject) {
      issues.push(`archive entry #${e.index} isn't an object`);
      continue;
    }
    if (!nonEmptyString(e.dataSourceId)) {
      issues.push(`archive entry #${e.index} names no data source`);
      continue;
    }
    if (!owners.has(e.dataSourceId)) {
      issues.push(`archive entry #${e.index} names a data source that isn't in this backup`);
      continue;
    }
    const list = byDs.get(e.dataSourceId) ?? [];
    list.push(e);
    byDs.set(e.dataSourceId, list);
  }

  // Archived ids claimed by more than one entry (across data sources) — both sides are suspect.
  const claims = new Map<string, number>();
  for (const list of byDs.values()) {
    for (const e of list) for (const id of new Set(e.pageIds)) claims.set(id, (claims.get(id) ?? 0) + 1);
  }

  const states = new Map<string, ArchiveDataSourceState>();
  const judge = (dsId: string, e: ArchiveEntryDigest): ArchiveDataSourceState => {
    const bad = (issue: string): ArchiveDataSourceState => ({ state: "inconsistent", issue });
    if (e.databaseId !== owners.get(dsId)) return bad("the entry's database doesn't own this data source");
    switch (e.state) {
      case "captured": {
        if (e.reason !== undefined) return bad("a captured entry carries a reason");
        if (e.pages !== "array") return bad("a captured entry has no pages list");
        if (e.invalidPages > 0) return bad(`${e.invalidPages} archived row(s) aren't valid backup pages`);
        if (e.pageIds.length === 0) return bad("a captured entry has no archived rows");
        if (new Set(e.pageIds).size !== e.pageIds.length) return bad("an archived row appears twice");
        if (e.pageIds.some((id) => isLive(id))) return bad("an archived row also appears as a live row or page");
        if (e.pageIds.some((id) => (claims.get(id) ?? 0) > 1)) return bad("an archived row appears in two data sources");
        return { state: "captured", pageCount: e.pageIds.length };
      }
      case "empty": {
        if (e.pages !== "absent") return bad("an empty entry carries pages");
        if (e.reason !== undefined) return bad("an empty entry carries a reason");
        return { state: capability === "proven" ? "confirmed_zero" : "unknown" };
      }
      case "unavailable": {
        if (e.pages !== "absent") return bad("an unavailable entry carries pages");
        if (!nonEmptyString(e.reason)) return bad("an unavailable entry has no reason");
        return { state: "unavailable", reason: e.reason };
      }
      default:
        return bad(`unknown entry state (${JSON.stringify(e.state ?? null)})`);
    }
  };
  for (const dsId of owners.keys()) {
    const list = byDs.get(dsId);
    if (!list) states.set(dsId, { state: "inconsistent", issue: "no archive entry for this data source" });
    else if (list.length > 1) states.set(dsId, { state: "inconsistent", issue: "more than one archive entry for this data source" });
    else states.set(dsId, judge(dsId, list[0]!));
  }

  return {
    section: "valid",
    capability,
    ...(header.stateChangedRows !== undefined ? { stateChangedRows: header.stateChangedRows } : {}),
    issues,
    stateOf: (ds) => states.get(ds) ?? unchecked,
  };
}

/** The in-memory reading: a parsed BackupFile → its archive view + the captured rows per data source. */
export interface ArchiveReading {
  view: ArchiveView;
  /** Archived rows of one data source — non-empty ONLY when its state is "captured". */
  archivedPagesOf(dataSourceId: string): BackupPage[];
}

const NONE: ArchiveReading = {
  view: { section: "none", issues: [], stateOf: () => ({ state: "unchecked" }) },
  archivedPagesOf: () => [],
};

export function readArchive(backup: Pick<BackupFile, "formatVersion" | "databases" | "pages"> & { archive?: unknown }): ArchiveReading {
  const hasSection = backup.archive !== undefined;
  // The common case (every v1/v2 file) costs nothing: no pass over rows.
  if (!hasSection && backup.formatVersion !== ARCHIVE_FORMAT_VERSION) return NONE;

  const owners = new Map<string, string>();
  for (const db of backup.databases) for (const ds of db.dataSources) owners.set(ds.id, db.id);
  const header = hasSection ? readArchiveHeader(backup.archive) : null;
  const pagesByEntry = new Map<number, BackupPage[]>();
  const entries: ArchiveEntryDigest[] = [];
  const raw = hasSection ? (backup.archive as Record<string, unknown> | null) : null;
  if (header?.ok && raw && Array.isArray(raw.dataSources)) {
    raw.dataSources.forEach((entry, i) => {
      const kept: BackupPage[] = [];
      entries.push(digestArchiveEntry(entry, i, (p) => kept.push(p)));
      pagesByEntry.set(i, kept);
    });
  }
  // Live ids are only needed to check archived ids against — so build them only when there are any.
  let live: Set<string> | null = null;
  const isLive = (id: string): boolean => {
    if (!live) {
      live = new Set<string>();
      for (const db of backup.databases) for (const ds of db.dataSources) for (const p of ds.pages) live.add(p.id);
      for (const p of backup.pages ?? []) live.add(p.id);
    }
    return live.has(id);
  };
  const view = buildArchiveView({ formatVersion: backup.formatVersion, hasSection, header, entries, owners, isLive });
  const entryOf = new Map<string, number>();
  for (const e of entries) if (typeof e.dataSourceId === "string") entryOf.set(e.dataSourceId, e.index);
  return {
    view,
    archivedPagesOf: (ds) => (view.stateOf(ds).state === "captured" ? (pagesByEntry.get(entryOf.get(ds)!) ?? []) : []),
  };
}

/** Data sources per archived-row state. `unknown` and `confirmedZero` stay apart: an empty answer is
 *  never zero unless the run proved the mechanism. */
export interface ArchivePartitionCounts {
  captured: number;
  confirmedZero: number;
  unknown: number;
  unavailable: number;
  inconsistent: number;
}

/** What a backup's archive section amounts to — the ONE tally every count/inspection helper reports. */
export interface ArchiveSummary {
  section: "valid" | "malformed";
  capability?: "proven" | "unproven";
  /** Archived rows captured (and trusted). Never part of any live row count. */
  capturedRows: number;
  partitions: ArchivePartitionCounts;
  /** Rows un-archived mid-backup (in neither list), when the section says so. */
  stateChangedRows?: number;
  /** Content-free: the section's own issues, then each inconsistent data source's ("<dsId>: …"). */
  issues: string[];
}

/**
 * What a COVERAGE surface may say about a backup's archived rows — structured state only, never
 * warning prose. undefined = nothing to say (every v1/v2 backup, and any run that never looked).
 *   capturedRows           archived rows captured and trusted — their own count, never a live row
 *   unconfirmed            some data source's archived rows were listed empty without proof, so they
 *                          weren't confirmed — NEVER "zero" (Notion answers the same with no Archive)
 *   unavailablePartitions  data sources whose archived rows couldn't be checked — a coverage exception
 *   inconsistent           the archive section doesn't hold together — the integrity verdict owns
 *                          that (src/core/integrity.ts); coverage may only explain it
 * A partition proven empty says nothing at all.
 */
export interface ArchiveCoverage {
  capturedRows: number;
  unconfirmed: boolean;
  unavailablePartitions: number;
  inconsistent: boolean;
}

/** Coverage from a parsed backup's archive summary (the artifact path). */
export function archiveCoverageOf(summary: ArchiveSummary | undefined): ArchiveCoverage | undefined {
  if (!summary) return undefined;
  return {
    capturedRows: summary.capturedRows,
    unconfirmed: summary.partitions.unknown > 0,
    unavailablePartitions: summary.partitions.unavailable,
    inconsistent: summary.section !== "valid" || summary.issues.length > 0,
  };
}

/**
 * Coverage from a backup point's STORED record — its manifest counts and its stored integrity flag
 * (the server path: the Protection Center never downloads the file). Reads the counters the
 * archived-row producer will write — nothing writes them yet, so every stored point reads undefined:
 *   archiveAware / archiveProven   the run's markers, read exactly as retention reads them (only a
 *                                  boolean `true` counts; any other shape is not proof)
 *   archivedRows                   archived rows captured (trusted only on a proven run)
 *   unlistableArchivedSources      data sources whose archived rows couldn't be listed
 *   dataSources                    live data sources in the run (to know whether any partition is
 *                                  left unconfirmed beside the unavailable ones)
 */
export function archiveCoverageFromCounts(
  counts: Record<string, unknown> | null | undefined,
  archiveInconsistent?: boolean,
): ArchiveCoverage | undefined {
  const c = counts ?? {};
  const marked = "archiveAware" in c || "archiveProven" in c;
  if (!marked && archiveInconsistent !== true) return undefined;
  const whole = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const proven = c.archiveAware === true && c.archiveProven === true;
  const unavailable = marked ? whole(c.unlistableArchivedSources) : 0;
  const dataSources = typeof c.dataSources === "number" && Number.isFinite(c.dataSources) ? c.dataSources : undefined;
  return {
    capturedRows: proven ? whole(c.archivedRows) : 0,
    unconfirmed: marked && !proven && (dataSources === undefined || dataSources > unavailable),
    unavailablePartitions: unavailable,
    inconsistent: archiveInconsistent === true,
  };
}

/** undefined for a backup with no archive section that isn't format 3 (every v1/v2 file) — there is
 *  nothing to report, and reporting zeros would claim archived rows were looked at. */
export function summarizeArchive(backup: Pick<BackupFile, "databases">, view: ArchiveView): ArchiveSummary | undefined {
  if (view.section === "none") return undefined;
  const partitions: ArchivePartitionCounts = { captured: 0, confirmedZero: 0, unknown: 0, unavailable: 0, inconsistent: 0 };
  const issues = [...view.issues];
  let capturedRows = 0;
  for (const db of backup.databases ?? []) {
    for (const ds of db.dataSources ?? []) {
      const st = view.stateOf(ds.id);
      switch (st.state) {
        case "captured":
          partitions.captured++;
          capturedRows += st.pageCount ?? 0;
          break;
        case "confirmed_zero":
          partitions.confirmedZero++;
          break;
        case "unknown":
          partitions.unknown++;
          break;
        case "unavailable":
          partitions.unavailable++;
          break;
        default:
          // "inconsistent" — and, defensively, anything else: a data source of THIS backup never reads
          // "unchecked" once a section exists, so an answer that does is not one to trust either.
          partitions.inconsistent++;
          issues.push(`${ds.id}: ${st.issue ?? `unexpected archive state (${st.state})`}`);
      }
    }
  }
  return {
    section: view.section,
    ...(view.capability ? { capability: view.capability } : {}),
    capturedRows,
    partitions,
    ...(view.stateChangedRows !== undefined ? { stateChangedRows: view.stateChangedRows } : {}),
    issues,
  };
}
