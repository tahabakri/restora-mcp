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
    properties: raw,
    views: z.array(backupViewSchema),
    pages: z.array(backupPageSchema),
  })
  .passthrough();

export const backupDatabaseSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
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

export const backupFileSchema = z.object({
  // v1 = no files captured (older backups still restore); v2 = hosted files downloaded into `files`.
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  notionVersion: z.string(),
  createdAt: z.string(),
  parentPageId: z.string().optional(),
  files: z.record(backupBlobSchema).optional(),
  databases: z.array(backupDatabaseSchema),
  // Standalone pages (nav/wiki/dashboard pages, not database rows) + their hierarchy. Optional and
  // additive: backups without it (every pre-feature backup, and database-only backups) omit it and
  // restore exactly as before. No formatVersion bump — a reader without page support simply ignores it.
  pages: z.array(backupStandalonePageSchema).optional(),
});

export type BackupFile = z.infer<typeof backupFileSchema>;
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

export const CURRENT_FORMAT_VERSION = 2 as const;
