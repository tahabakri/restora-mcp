/**
 * Pure, read-only query engine over a parsed Restora backup. This is the brain behind the CLI's MCP
 * server (cli/src/mcp.ts): it turns Notion's opaque raw property values into readable data an AI agent
 * can reason over, resolves relations to the linked page TITLES, and answers list/describe/query/search.
 *
 * Pure by design — it takes an already-parsed backup object and does NO file/network I/O, NO logging,
 * NO mutation. All side effects (reading files, talking to Notion) live in the CLI layer. This mirrors
 * the in-memory-core / file-subclass split used for IdMap (src/lib/idmap.ts) and keeps the module
 * Node + Worker + browser safe and trivially testable (scripts/mcp-tools-test.ts).
 */
import {
  backupFileSchema,
  type BackupFile,
  type BackupDatabase,
  type BackupDataSource,
  type BackupPage,
  type BackupStandalonePage,
} from "../notion/types.js";
import { pageTitle, renderBlocks, blocksToPlainText, plainText } from "./render-md.js";
import { assembleTree, buildPathMap, type WorkspaceItem } from "./tree.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Cap a single readable value so one giant cell can't dominate the agent's context window. */
const VALUE_CAP = 500;
const cap = (s: string): string => (s.length > VALUE_CAP ? s.slice(0, VALUE_CAP) + "…" : s);

/** First 8 chars of a Notion id — a stable short handle for unresolved references. */
const shortId = (id: string): string => (typeof id === "string" ? id.slice(0, 8) : String(id));

/**
 * Validate the envelope and return a typed BackupFile. Throws a friendly error for anything that isn't
 * a Restora backup (e.g. a restore-map-*.json or an unrelated JSON file).
 */
export function parseBackup(json: unknown): BackupFile {
  const parsed = backupFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      "Not a Restora backup file (missing the backup envelope: formatVersion / databases). " +
        "If this is a restore id-map, use read_id_map instead.",
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------------
// Resolver — one pass over the backup, then O(1) lookups (relation id → title, page id → page, …).
// ---------------------------------------------------------------------------------------------------

export interface ResolvedPage {
  page: BackupPage;
  dataSourceId: string;
  dataSourceName: string;
  dbTitle: string;
}

export interface Resolver {
  pageById: Map<string, ResolvedPage>;
  titleById: Map<string, string>;
  dataSourceById: Map<string, { ds: BackupDataSource; dbTitle: string }>;
  databaseById: Map<string, BackupDatabase>;
}

const dsDisplayName = (ds: BackupDataSource, dbTitle: string): string => ds.name || dbTitle || "Data source";

/** Group label for standalone (nav/wiki/dashboard) pages in resolver/search output. */
const PAGES_GROUP = "Pages";

/**
 * Present a standalone page as a row-shaped `BackupPage` so the resolver, markdown, and search paths
 * treat it uniformly (its title rich-text becomes a synthetic `title` property; it has no DB columns).
 */
function standaloneAsPage(p: BackupStandalonePage): BackupPage {
  return {
    id: p.id,
    created_time: p.created_time,
    icon: p.icon ?? null,
    cover: p.cover ?? null,
    properties: { Title: { type: "title", title: Array.isArray(p.title) ? p.title : [] } },
    blocks: p.blocks ?? [],
    ...(p.comments ? { comments: p.comments } : {}),
  } as BackupPage;
}

export function buildResolver(backup: BackupFile): Resolver {
  const pageById = new Map<string, ResolvedPage>();
  const titleById = new Map<string, string>();
  const dataSourceById = new Map<string, { ds: BackupDataSource; dbTitle: string }>();
  const databaseById = new Map<string, BackupDatabase>();

  for (const db of backup.databases ?? []) {
    const dbTitle = db.title || "Untitled database";
    if (db.id) databaseById.set(db.id, db);
    for (const ds of db.dataSources ?? []) {
      const dataSourceName = dsDisplayName(ds, dbTitle);
      if (ds.id) dataSourceById.set(ds.id, { ds, dbTitle });
      for (const page of ds.pages ?? []) {
        if (!page?.id) continue;
        const title = pageTitle(page.properties ?? {});
        pageById.set(page.id, { page, dataSourceId: ds.id, dataSourceName, dbTitle });
        titleById.set(page.id, title);
      }
    }
  }
  // Standalone pages — indexed alongside rows so get_page / relation-title / search resolve them too.
  for (const sp of backup.pages ?? []) {
    if (!sp?.id) continue;
    const page = standaloneAsPage(sp);
    pageById.set(sp.id, { page, dataSourceId: "", dataSourceName: PAGES_GROUP, dbTitle: PAGES_GROUP });
    titleById.set(sp.id, pageTitle(page.properties));
  }
  return { pageById, titleById, dataSourceById, databaseById };
}

// ---------------------------------------------------------------------------------------------------
// Property flattening — raw Notion property VALUES → readable values (the main engineering work).
// ---------------------------------------------------------------------------------------------------

export type PropValue = string | number | boolean | string[] | null;

function flattenRollup(r: any, resolver?: Resolver): PropValue {
  if (!r || typeof r !== "object") return null;
  switch (r.type) {
    case "number":
      return typeof r.number === "number" ? r.number : null;
    case "date":
      return r.date ? [r.date.start, r.date.end].filter(Boolean).join(" → ") || null : null;
    case "array": {
      const arr = (r.array ?? [])
        .map((el: any) => {
          const fv = flattenProperty(el, resolver);
          if (fv === null) return "";
          return Array.isArray(fv) ? fv.join(", ") : String(fv);
        })
        .filter(Boolean);
      return arr.length ? (arr as string[]) : null;
    }
    default: {
      const raw = r[r.type];
      if (raw == null) return null;
      return typeof raw === "object" ? cap(JSON.stringify(raw)) : (raw as PropValue);
    }
  }
}

function flattenFormula(f: any): PropValue {
  if (!f || typeof f !== "object") return null;
  switch (f.type) {
    case "string":
      return f.string != null ? cap(String(f.string)) : null;
    case "number":
      return typeof f.number === "number" ? f.number : null;
    case "boolean":
      return typeof f.boolean === "boolean" ? f.boolean : null;
    case "date":
      return f.date ? [f.date.start, f.date.end].filter(Boolean).join(" → ") || null : null;
    default:
      return null;
  }
}

/** A single raw Notion property value → a readable JS value. Relations resolve to linked page titles. */
export function flattenProperty(v: any, resolver?: Resolver): PropValue {
  if (!v || typeof v !== "object") return null;
  switch (v.type) {
    case "title":
      return cap(plainText(v.title)) || null;
    case "rich_text":
      return cap(plainText(v.rich_text)) || null;
    case "select":
      return v.select?.name ?? null;
    case "status":
      return v.status?.name ?? null;
    case "multi_select":
      return (v.multi_select ?? []).map((o: any) => o?.name).filter(Boolean);
    case "date":
      return v.date ? [v.date.start, v.date.end].filter(Boolean).join(" → ") || null : null;
    case "number":
      return typeof v.number === "number" ? v.number : null;
    case "checkbox":
      return !!v.checkbox;
    case "url":
      return v.url || null;
    case "email":
      return v.email || null;
    case "phone_number":
      return v.phone_number || null;
    case "people":
      return (v.people ?? []).map((p: any) => p?.name ?? (p?.id ? shortId(p.id) : null)).filter(Boolean);
    case "created_by":
      return v.created_by?.name ?? (v.created_by?.id ? shortId(v.created_by.id) : null);
    case "last_edited_by":
      return v.last_edited_by?.name ?? (v.last_edited_by?.id ? shortId(v.last_edited_by.id) : null);
    case "created_time":
      return v.created_time ?? null;
    case "last_edited_time":
      return v.last_edited_time ?? null;
    case "files":
      return (v.files ?? [])
        .map((f: any) => f?.name || f?.external?.url || f?.file?.url || (f?.restora_key ? `(file: ${f.restora_key})` : ""))
        .filter(Boolean);
    case "relation": {
      // A relation target that isn't in the backup is almost always a link to a database that wasn't
      // included (a partial/scoped backup) — say so plainly rather than showing an opaque id.
      const ids: any[] = v.relation ?? [];
      const titles = ids.map((r) => resolver?.titleById.get(r?.id) ?? "(not in this backup)");
      if (v.has_more) titles.push("…(+more)");
      return titles.length ? titles : null;
    }
    case "rollup":
      return flattenRollup(v.rollup, resolver);
    case "formula":
      return flattenFormula(v.formula);
    case "unique_id":
      return v.unique_id
        ? `${v.unique_id.prefix ? v.unique_id.prefix + "-" : ""}${v.unique_id.number}`
        : null;
    case "verification":
      return v.verification?.state ?? null;
    default: {
      // Safe fallback for any future/unknown type — never throw, never dump huge raw JSON.
      const raw = v[v.type];
      if (raw == null) return null;
      try {
        return cap(typeof raw === "string" ? raw : JSON.stringify(raw));
      } catch {
        return null;
      }
    }
  }
}

/** All non-title, non-empty properties of a page → { name: readableValue }. Title is surfaced separately. */
export function flattenPageProperties(page: BackupPage, resolver?: Resolver): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [name, v] of Object.entries(page.properties ?? {})) {
    if ((v as any)?.type === "title") continue;
    const fv = flattenProperty(v, resolver);
    if (fv === null || (Array.isArray(fv) && fv.length === 0)) continue;
    out[name] = fv;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Workspace map — databases → data sources → property schema, relations graph, views.
// ---------------------------------------------------------------------------------------------------

export interface WorkspaceMapProperty {
  name: string;
  type: string;
  options?: string[];
  relation?: { targetDataSourceId?: string; targetDatabaseId?: string; dual: boolean; resolvableInBackup: boolean };
  rollup?: { function?: string; relationProperty?: string; rollupProperty?: string };
}
export interface WorkspaceMapView {
  id: string;
  type: string;
  name: string;
  hasFilter: boolean;
  hasSorts: boolean;
}
export interface WorkspaceMapDataSource {
  id: string;
  name: string;
  pageCount: number;
  viewCount: number;
  properties: WorkspaceMapProperty[];
  views: WorkspaceMapView[];
}
export interface WorkspaceMapDatabase {
  id: string;
  title: string;
  icon: string | null;
  dataSources: WorkspaceMapDataSource[];
}
export interface WorkspaceRelation {
  fromDataSourceId: string;
  fromDataSource: string;
  property: string;
  toDataSourceId?: string;
  toDatabaseId?: string;
  resolvableInBackup: boolean;
}
export interface WorkspaceMap {
  createdAt: string;
  formatVersion: number;
  notionVersion: string;
  fileCount: number;
  databaseCount: number;
  dataSourceCount: number;
  pageCount: number;
  databases: WorkspaceMapDatabase[];
  relations: WorkspaceRelation[];
}

const iconText = (icon: any): string | null =>
  icon?.type === "emoji" ? (icon.emoji ?? null) : icon?.type ? `(${icon.type})` : null;

const viewName = (v: any): string => (typeof v?.name === "string" && v.name) || "Untitled view";

function projectProperty(name: string, prop: any, dataSourceById: Map<string, unknown>): WorkspaceMapProperty {
  const type = prop?.type ?? "unknown";
  const out: WorkspaceMapProperty = { name, type };
  if (type === "select" || type === "multi_select" || type === "status") {
    const opts = prop?.[type]?.options ?? [];
    const names = opts.map((o: any) => o?.name).filter(Boolean);
    if (names.length) out.options = names;
  } else if (type === "relation") {
    const rel = prop?.relation ?? {};
    out.relation = {
      targetDataSourceId: rel.data_source_id,
      targetDatabaseId: rel.database_id,
      dual: rel.type === "dual_property",
      resolvableInBackup: !!rel.data_source_id && dataSourceById.has(rel.data_source_id),
    };
  } else if (type === "rollup") {
    const r = prop?.rollup ?? {};
    out.rollup = {
      function: r.function,
      relationProperty: r.relation_property_name,
      rollupProperty: r.rollup_property_name,
    };
  }
  return out;
}

export function buildWorkspaceMap(backup: BackupFile, resolver?: Resolver): WorkspaceMap {
  const r = resolver ?? buildResolver(backup);
  const databases: WorkspaceMapDatabase[] = [];
  const relations: WorkspaceRelation[] = [];
  let dataSourceCount = 0;
  let pageCount = 0;

  for (const db of backup.databases ?? []) {
    const dbTitle = db.title || "Untitled database";
    const dsList: WorkspaceMapDataSource[] = [];
    for (const ds of db.dataSources ?? []) {
      dataSourceCount++;
      const dsName = dsDisplayName(ds, dbTitle);
      const pages = Array.isArray(ds.pages) ? ds.pages.length : 0;
      pageCount += pages;

      const properties: WorkspaceMapProperty[] = [];
      for (const [name, prop] of Object.entries(ds.properties ?? {})) {
        const projected = projectProperty(name, prop, r.dataSourceById);
        properties.push(projected);
        if (projected.relation) {
          relations.push({
            fromDataSourceId: ds.id,
            fromDataSource: dsName,
            property: name,
            toDataSourceId: projected.relation.targetDataSourceId,
            toDatabaseId: projected.relation.targetDatabaseId,
            resolvableInBackup: projected.relation.resolvableInBackup,
          });
        }
      }

      const views: WorkspaceMapView[] = (ds.views ?? []).map((v: any) => ({
        id: v.id,
        type: v.type ?? "unknown",
        name: viewName(v),
        hasFilter: v.filter != null,
        hasSorts: Array.isArray(v.sorts) && v.sorts.length > 0,
      }));

      dsList.push({ id: ds.id, name: dsName, pageCount: pages, viewCount: views.length, properties, views });
    }
    databases.push({ id: db.id, title: dbTitle, icon: iconText(db.icon), dataSources: dsList });
  }

  return {
    createdAt: backup.createdAt,
    formatVersion: backup.formatVersion,
    notionVersion: backup.notionVersion,
    fileCount: backup.files ? Object.keys(backup.files).length : 0,
    databaseCount: (backup.databases ?? []).length,
    dataSourceCount,
    pageCount,
    databases,
    relations,
  };
}

// ---------------------------------------------------------------------------------------------------
// query_database — rows of one data source with flattened, relation-resolved values.
// ---------------------------------------------------------------------------------------------------

export interface QueryRow {
  id: string;
  title: string;
  props: Record<string, PropValue>;
}
export interface QueryResult {
  dataSource: { id: string; name: string };
  total: number;
  offset: number;
  limit: number;
  returned: number;
  truncated: boolean;
  note?: string;
  rows: QueryRow[];
}
export interface QueryOptions {
  dataSourceId?: string;
  databaseId?: string;
  limit?: number;
  offset?: number;
  properties?: string[];
  filterText?: string;
}

/** Thrown when a databaseId maps to >1 data source — the caller must pick one. Carries the candidates. */
export class AmbiguousDataSourceError extends Error {
  constructor(public candidates: Array<{ id: string; name: string }>) {
    super(
      `That database has ${candidates.length} data sources — call again with one of dataSourceId: ` +
        candidates.map((c) => `${c.id} (${c.name})`).join(", "),
    );
    this.name = "AmbiguousDataSourceError";
  }
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function resolveDataSource(
  resolver: Resolver,
  opts: QueryOptions,
): { ds: BackupDataSource; dbTitle: string } {
  if (opts.dataSourceId) {
    const hit = resolver.dataSourceById.get(opts.dataSourceId);
    if (!hit) throw new Error(`No data source ${opts.dataSourceId} in this backup.`);
    return hit;
  }
  if (opts.databaseId) {
    const db = resolver.databaseById.get(opts.databaseId);
    if (!db) throw new Error(`No database ${opts.databaseId} in this backup.`);
    const sources = db.dataSources ?? [];
    if (sources.length === 0) throw new Error(`Database ${opts.databaseId} has no data sources.`);
    if (sources.length > 1) {
      throw new AmbiguousDataSourceError(
        sources.map((ds) => ({ id: ds.id, name: dsDisplayName(ds, db.title || "") })),
      );
    }
    return { ds: sources[0]!, dbTitle: db.title || "Untitled database" };
  }
  throw new Error("Provide either dataSourceId or databaseId.");
}

export function queryDataSource(backup: BackupFile, resolver: Resolver, opts: QueryOptions): QueryResult {
  void backup; // kept in the public signature for symmetry with the other query fns
  const { ds, dbTitle } = resolveDataSource(resolver, opts);
  const dsName = dsDisplayName(ds, dbTitle);
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);
  const wanted = opts.properties && opts.properties.length ? new Set(opts.properties) : null;
  const needle = opts.filterText?.toLowerCase();

  let pages = ds.pages ?? [];
  if (needle) {
    pages = pages.filter((p) => {
      const title = pageTitle(p.properties ?? {}).toLowerCase();
      if (title.includes(needle)) return true;
      const flat = flattenPageProperties(p, resolver);
      return Object.values(flat).some((v) =>
        (Array.isArray(v) ? v.join(" ") : String(v ?? "")).toLowerCase().includes(needle),
      );
    });
  }

  const total = pages.length;
  const slice = pages.slice(offset, offset + limit);
  const rows: QueryRow[] = slice.map((p) => {
    let props = flattenPageProperties(p, resolver);
    if (wanted) props = Object.fromEntries(Object.entries(props).filter(([k]) => wanted.has(k)));
    return { id: p.id, title: pageTitle(p.properties ?? {}), props };
  });

  const truncated = offset + slice.length < total;
  return {
    dataSource: { id: ds.id, name: dsName },
    total,
    offset,
    limit,
    returned: rows.length,
    truncated,
    note: truncated ? `${total - offset - slice.length} more — call again with offset=${offset + slice.length}.` : undefined,
    rows,
  };
}

// ---------------------------------------------------------------------------------------------------
// get_page — one page's properties + content as Markdown (or plain text).
// ---------------------------------------------------------------------------------------------------

const BODY_CAP = 20000;

function renderPropValue(v: PropValue): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "✓" : "✗";
  return String(v);
}

export function getPageMarkdown(
  resolver: Resolver,
  pageId: string,
  format: "markdown" | "text" = "markdown",
): string {
  const hit = resolver.pageById.get(pageId);
  if (!hit) throw new Error(`No page ${pageId} in this backup.`);
  const { page, dataSourceName, dbTitle } = hit;
  const title = pageTitle(page.properties ?? {});
  const props = flattenPageProperties(page, resolver);

  const lines: string[] = [];
  lines.push(format === "markdown" ? `# ${title}` : title);
  lines.push("");
  const sourceLine = `${dbTitle}${dataSourceName && dataSourceName !== dbTitle ? " · " + dataSourceName : ""}`;
  lines.push(format === "markdown" ? `_${sourceLine}_` : sourceLine);
  lines.push("");
  const propLines = Object.entries(props).map(([name, v]) =>
    format === "markdown" ? `- **${name}:** ${renderPropValue(v)}` : `${name}: ${renderPropValue(v)}`,
  );
  if (propLines.length) {
    lines.push(...propLines, "");
  }

  let body = format === "markdown" ? renderBlocks(page.blocks ?? []) : blocksToPlainText(page.blocks ?? []);
  if (body.length > BODY_CAP) body = body.slice(0, BODY_CAP) + "\n\n…(content truncated)";
  if (body) lines.push(body);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------------------------------
// search — substring over titles / property values / block text.
// ---------------------------------------------------------------------------------------------------

export type SearchScope = "titles" | "content" | "all";
export interface SearchHit {
  pageId: string;
  title: string;
  dataSource: string;
  matchIn: "title" | "property" | "block";
  snippet: string;
  /** The database this row belongs to (rows only). Lets the UI show a "Database › Data source" crumb. */
  dbTitle?: string;
  /** Ancestor titles (root-first) for a standalone page, when its parents are also in the backup.
   *  Empty when the page is top-level or its parent wasn't backed up. Databases have no parent link
   *  in the backup, so rows never carry a `path` — they use `dbTitle`/`dataSource` instead. */
  path?: string[];
}
export interface SearchResult {
  query: string;
  total: number;
  returned: number;
  truncated: boolean;
  hits: SearchHit[];
}

const SNIPPET_RADIUS = 100;
function snippet(haystack: string, needleLower: string): string {
  const i = haystack.toLowerCase().indexOf(needleLower);
  if (i < 0) return cap(haystack);
  const start = Math.max(0, i - SNIPPET_RADIUS);
  const end = Math.min(haystack.length, i + needleLower.length + SNIPPET_RADIUS);
  return (start > 0 ? "…" : "") + haystack.slice(start, end).trim() + (end < haystack.length ? "…" : "");
}

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

export function searchBackup(
  backup: BackupFile,
  resolver: Resolver,
  query: string,
  scope: SearchScope = "all",
  limit = DEFAULT_SEARCH_LIMIT,
): SearchResult {
  const needle = (query ?? "").toLowerCase().trim();
  const lim = Math.min(MAX_SEARCH_LIMIT, Math.max(1, limit));
  const hits: SearchHit[] = [];
  let total = 0;
  if (!needle) return { query, total: 0, returned: 0, truncated: false, hits };

  const wantTitles = scope === "titles" || scope === "all";
  const wantContent = scope === "content" || scope === "all";

  for (const db of backup.databases ?? []) {
    for (const ds of db.dataSources ?? []) {
      const dsName = dsDisplayName(ds, db.title || "");
      const dbTitle = db.title || "Untitled database";
      for (const page of ds.pages ?? []) {
        const title = pageTitle(page.properties ?? {});
        let hit: SearchHit | null = null;
        if (wantTitles && title.toLowerCase().includes(needle)) {
          hit = { pageId: page.id, title, dataSource: dsName, matchIn: "title", snippet: title, dbTitle };
        }
        if (!hit && wantContent) {
          const flat = flattenPageProperties(page, resolver);
          for (const [name, v] of Object.entries(flat)) {
            const text = Array.isArray(v) ? v.join(", ") : String(v ?? "");
            if (text.toLowerCase().includes(needle)) {
              hit = { pageId: page.id, title, dataSource: dsName, matchIn: "property", snippet: `${name}: ${snippet(text, needle)}`, dbTitle };
              break;
            }
          }
        }
        if (!hit && wantContent) {
          const blockText = blocksToPlainText(page.blocks ?? []);
          if (blockText.toLowerCase().includes(needle)) {
            hit = { pageId: page.id, title, dataSource: dsName, matchIn: "block", snippet: snippet(blockText, needle), dbTitle };
          }
        }
        if (hit) {
          total++;
          if (hits.length < lim) hits.push(hit);
        }
      }
    }
  }

  // Standalone pages — same title/property/block matching, grouped under "Pages". Build the parent
  // path map once so each hit can show its "Home › Projects" ancestry (only pages carry a parent link;
  // pages whose parent wasn't backed up flatten to a root → empty path, an honest degradation).
  const spItems: WorkspaceItem[] = (backup.pages ?? []).map((sp) => ({
    id: sp.id,
    kind: "page" as const,
    title: pageTitle(standaloneAsPage(sp).properties),
    parentId: sp.parent?.id,
    parentType: sp.parent?.type,
  }));
  const pathMap = buildPathMap(assembleTree(spItems));
  for (const sp of backup.pages ?? []) {
    const page = standaloneAsPage(sp);
    const title = pageTitle(page.properties);
    const path = pathMap.get(sp.id) ?? [];
    let hit: SearchHit | null = null;
    if (wantTitles && title.toLowerCase().includes(needle)) {
      hit = { pageId: page.id, title, dataSource: PAGES_GROUP, matchIn: "title", snippet: title, path };
    }
    if (!hit && wantContent) {
      const blockText = blocksToPlainText(page.blocks ?? []);
      if (blockText.toLowerCase().includes(needle)) {
        hit = { pageId: page.id, title, dataSource: PAGES_GROUP, matchIn: "block", snippet: snippet(blockText, needle), path };
      }
    }
    if (hit) {
      total++;
      if (hits.length < lim) hits.push(hit);
    }
  }

  return { query, total, returned: hits.length, truncated: total > hits.length, hits };
}

// ---------------------------------------------------------------------------------------------------
// list_backups support — summarize an already-parsed backup (file I/O stays in the CLI layer).
// ---------------------------------------------------------------------------------------------------

export interface BackupSummary {
  formatVersion: number;
  notionVersion: string;
  createdAt: string;
  databaseCount: number;
  dataSourceCount: number;
  pageCount: number;
  fileCount: number;
  viewCount: number;
  relationLinkCount: number;
  standalonePageCount: number;
  /** Approximate decoded size of all captured attachments (base64 length × 3/4). */
  attachmentBytes: number;
}

export function summarizeBackup(backup: BackupFile): BackupSummary {
  let dataSourceCount = 0;
  let pageCount = 0;
  let viewCount = 0;
  let relationLinkCount = 0;
  for (const db of backup.databases ?? []) {
    for (const ds of db.dataSources ?? []) {
      dataSourceCount++;
      viewCount += Array.isArray(ds.views) ? ds.views.length : 0;
      pageCount += Array.isArray(ds.pages) ? ds.pages.length : 0;
      for (const page of ds.pages ?? []) {
        for (const value of Object.values<any>(page.properties ?? {})) {
          if (value && Array.isArray(value.relation)) relationLinkCount += value.relation.length;
        }
      }
    }
  }
  let attachmentBytes = 0;
  for (const blob of Object.values(backup.files ?? {})) {
    const data = (blob as { data?: unknown })?.data;
    if (typeof data === "string") attachmentBytes += Math.floor(data.length * 0.75);
  }
  return {
    formatVersion: backup.formatVersion,
    notionVersion: backup.notionVersion,
    createdAt: backup.createdAt,
    databaseCount: (backup.databases ?? []).length,
    dataSourceCount,
    pageCount,
    fileCount: backup.files ? Object.keys(backup.files).length : 0,
    viewCount,
    relationLinkCount,
    standalonePageCount: (backup.pages ?? []).length,
    attachmentBytes,
  };
}
