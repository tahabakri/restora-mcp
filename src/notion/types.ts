/**
 * The backup-file format and a zod validator for it.
 *
 * We deliberately keep Notion's raw objects (property schemas, property values,
 * view configs, blocks) as opaque pass-through JSON. Notion's type surface is huge
 * and changes often; faithfully re-typing it would be brittle and pointless. zod's
 * job here is to guarantee the *envelope* is well-formed when we read a backup back,
 * not to police every Notion field.
 */
import { z } from "zod";

/** An opaque chunk of Notion JSON we store verbatim and replay later. */
const raw = z.record(z.any());

/** A block with its recursively-fetched children attached under `children`. */
export const backupBlockSchema: z.ZodType<BackupBlock> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      type: z.string(),
      has_children: z.boolean().optional(),
      children: z.array(backupBlockSchema).optional(),
    })
    .passthrough(),
);

export const backupPageSchema = z
  .object({
    id: z.string(),
    created_time: z.string().optional(),
    // Archival metadata (2026-08-08, additive): last_edited_time was passthrough-only before —
    // declared now; created_by/last_edited_by are verbatim user stubs the restore never writes
    // (Notion's API can't set them). `.catch(undefined)` so a malformed value degrades to absent.
    last_edited_time: z.string().optional().catch(undefined),
    created_by: raw.optional().catch(undefined),
    last_edited_by: raw.optional().catch(undefined),
    icon: z.any().nullable().optional(),
    cover: z.any().nullable().optional(),
    properties: raw,
    blocks: z.array(backupBlockSchema),
    // Read-only archival capture (v2+). Restore can't recreate comments, so these are stored for the
    // record only. Opaque Notion comment objects; omitted entirely when a page has none.
    comments: z.array(raw).optional(),
  })
  .passthrough();

export const backupViewSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    name: z.any().optional(),
  })
  .passthrough();

/**
 * A standalone Notion PAGE (a nav/wiki/dashboard page — NOT a database row). Captured top-level in
 * `BackupFile.pages` so the workspace's page-navigation hierarchy can be backed up and restored, not
 * just databases. `parent` is normalized at capture to `{ type, id? }` (id = the page_id/workspace
 * has none) so restore can rebuild nesting without re-parsing Notion's per-type parent shape. `title`
 * is the page's title rich-text array (a standalone page has no database-column `properties` map).
 */
export const backupStandalonePageSchema = z
  .object({
    id: z.string(),
    parent: z.object({ type: z.string(), id: z.string().optional() }).passthrough(),
    created_time: z.string().optional(),
    // Archival metadata — same additive trio as backupPageSchema (2026-08-08).
    last_edited_time: z.string().optional().catch(undefined),
    created_by: raw.optional().catch(undefined),
    last_edited_by: raw.optional().catch(undefined),
    icon: z.any().nullable().optional(),
    cover: z.any().nullable().optional(),
    title: z.array(z.any()).optional(),
    blocks: z.array(backupBlockSchema),
    comments: z.array(raw).optional(),
  })
  .passthrough();

export const backupDataSourceSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    // Archival timestamps (2026-08-08, additive — data sources carried none before).
    created_time: z.string().optional().catch(undefined),
    last_edited_time: z.string().optional().catch(undefined),
    properties: raw,
    views: z.array(backupViewSchema),
    // Views the READ endpoint refused (e.g. "Unsupported view type: page") — id + layout type when
    // the error named it. The only in-artifact record of what capture had to skip (2026-08-08).
    skippedViewRefs: z
      .array(z.object({ id: z.string(), type: z.string().optional() }).passthrough())
      .optional()
      .catch(undefined),
    pages: z.array(backupPageSchema),
  })
  .passthrough();

export const backupDatabaseSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    // Archival timestamps (2026-08-08, additive — the database object carried none before).
    created_time: z.string().optional().catch(undefined),
    last_edited_time: z.string().optional().catch(undefined),
    /** Raw rich-text description (audit I5 — was a silent product-wide capture gap). */
    description: z.any().optional(),
    icon: z.any().nullable().optional(),
    cover: z.any().nullable().optional(),
    dataSources: z.array(backupDataSourceSchema),
  })
  .passthrough();

/** A Notion-hosted file we downloaded at backup time (its source URL expires in ~1h). Keyed by an
 *  opaque id in BackupFile.files; references (icons/covers, later file values/blocks) carry that key
 *  as `restora_key` so restore re-uploads the bytes via the File Upload API. v2+ only. */
export const backupBlobSchema = z.object({
  name: z.string(),
  content_type: z.string().optional(),
  data: z.string(), // base64
});

/** A large file captured as a SIDECAR OBJECT next to the backup in the user's own Drive/S3 (server
 *  runs only) — the backup JSON holds this stub; the bytes live in `object` (a Drive file id or S3
 *  key). References still carry the same `restora_key`. Readers without sidecar support skip the
 *  unknown top-level key and treat the ref as an absent blob — a NAMED skip, never a crash. */
export const backupSidecarStubSchema = z.object({
  name: z.string(),
  content_type: z.string().optional(),
  bytes: z.number(),
  object: z.string(),
});

/** A backup whose format is newer than anything this build reads — the one message every validator
 *  uses, so a reader never calls a newer Restora's file "not a backup". */
export function newerFormatMessage(formatVersion: unknown): string {
  return `This backup was made by a newer version of Restora (format ${String(formatVersion)}). Update Restora to open it.`;
}
const isNewerFormat = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v > 3;

export const backupFileSchema = z.object({
  // v1 = no files captured (older backups still restore); v2 = hosted files downloaded into `files`;
  // v3 = the top-level `archive` section below. READ-only so far: every writer still emits
  // CURRENT_FORMAT_VERSION (2), and nothing emits 3 until archived-row capture ships.
  formatVersion: z.union([z.literal(1), z.literal(2), z.literal(3)], {
    errorMap: (_issue, ctx) => ({ message: isNewerFormat(ctx.data) ? newerFormatMessage(ctx.data) : ctx.defaultError }),
  }),
  notionVersion: z.string(),
  createdAt: z.string(),
  // Source-workspace provenance (additive, 2026-08-28). `id` is the ONLY comparison key — `name` is
  // display-only and must never be used for identity. Optional and no formatVersion bump: old
  // readers strip the unknown key, old artifacts simply lack it (and stay warn-only in the restore
  // UI — never guessed from names or content probes).
  sourceWorkspace: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  parentPageId: z.string().optional(),
  files: z.record(backupBlobSchema).optional(),
  // Large-file sidecar stubs (additive, 2026-08-07). No formatVersion bump: a reader without
  // sidecar support ignores the key, and every ref it can't resolve is already a named skip.
  sidecars: z.record(backupSidecarStubSchema).optional(),
  databases: z.array(backupDatabaseSchema),
  // Standalone pages (nav/wiki/dashboard pages, not database rows) + their hierarchy. Optional and
  // additive: backups without it (every pre-feature backup, and database-only backups) omit it and
  // restore exactly as before. No formatVersion bump — a reader without page support simply ignores it.
  pages: z.array(backupStandalonePageSchema).optional(),
  // Archived Notion rows (format 3). Kept VERBATIM here and read ONLY through src/core/archive-state.ts,
  // which associates each entry with its data source and validates it there: a malformed section
  // degrades to named "inconsistent" states, never to a whole-file parse failure (the live data stays
  // readable) and never to "captured" or a confirmed zero. Absent on every v1/v2 file.
  archive: z.unknown().optional(),
});

export type BackupFile = z.infer<typeof backupFileSchema>;
export type BackupSidecarStub = z.infer<typeof backupSidecarStubSchema>;
export type BackupDatabase = z.infer<typeof backupDatabaseSchema>;
export type BackupDataSource = z.infer<typeof backupDataSourceSchema>;
export type BackupPage = z.infer<typeof backupPageSchema>;
export type BackupStandalonePage = z.infer<typeof backupStandalonePageSchema>;
export type BackupView = z.infer<typeof backupViewSchema>;

/** Recursive block type (zod can't infer the self-reference cleanly). */
export interface BackupBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: BackupBlock[];
  [key: string]: unknown;
}

/** The format every WRITER emits. Unchanged by format 3: no code path writes 3 yet. */
export const CURRENT_FORMAT_VERSION = 2 as const;
/** The format that carries the top-level `archive` section — readers only, until capture ships. */
export const ARCHIVE_FORMAT_VERSION = 3 as const;
