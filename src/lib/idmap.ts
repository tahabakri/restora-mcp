/**
 * Old-ID -> new-ID maps for restore. In-memory core (no filesystem) so it runs
 * identically in a Node CLI and in a Cloudflare Worker. The CLI uses the
 * `FileIdMap` subclass (idmap-file.ts) to also persist to disk for resumability;
 * the synchronous Worker doesn't resume mid-request, so it uses this base directly.
 *
 * Identity namespaces (oldId -> newId), matched by NAME when we read the recreated
 * schema back because Notion assigns fresh IDs to every property and option:
 *  - dataSources     old data_source_id -> new data_source_id
 *  - pages           old page_id        -> new page_id
 *  - propIds         old property_id    -> new property_id   (per recreated schema)
 *  - optionIds       old option_id      -> new option_id     (select/status/multi)
 *  - statusGroupIds  old status group   -> new status group
 *
 * Resume/idempotency namespaces (checkpoint markers — value is "1", key is what's done).
 * They let a killed restore resume with ZERO duplicates (only Step 2 was guarded before):
 *  - metadata        misc state: "containerPageId", "db::<oldDbId>" -> newDbId,
 *                    "defaults::<newDsId>" (csv of auto-view ids), "defDeleted::<newDsId>"
 *  - relProps        relation property created: "<newDsId>::<name>" or "pair::<pairKey>"
 *  - rollups         rollup property resolved (created, skipped, or gave up): "<newDsId>::<name>"
 *  - relLinks        relation VALUES written for a page: "<oldPageId>"
 *  - blocksAdded     Step-3 content (props + blocks) written for a DB-row page: "<oldPageId>"
 *  - views           view created: "<newDsId>::v<index>"
 *  - pageBlocksAdded Step-8b content written for a STANDALONE page: "<oldPageId>" (kept apart from
 *                    blocksAdded so the row path and the page path can't trample each other's resume state)
 */

export interface IdMapData {
  dataSources: Record<string, string>;
  pages: Record<string, string>;
  propIds: Record<string, string>;
  optionIds: Record<string, string>;
  statusGroupIds: Record<string, string>;
  metadata: Record<string, string>;
  relProps: Record<string, string>;
  rollups: Record<string, string>;
  relLinks: Record<string, string>;
  blocksAdded: Record<string, string>;
  views: Record<string, string>;
  pageBlocksAdded: Record<string, string>;
}

export type Namespace = keyof IdMapData;

const EMPTY: IdMapData = {
  dataSources: {},
  pages: {},
  propIds: {},
  optionIds: {},
  statusGroupIds: {},
  metadata: {},
  relProps: {},
  rollups: {},
  relLinks: {},
  blocksAdded: {},
  views: {},
  pageBlocksAdded: {},
};

export class IdMap {
  readonly data: IdMapData;

  constructor(initial?: Partial<IdMapData>) {
    this.data = { ...structuredClone(EMPTY), ...(initial ? structuredClone(initial) : {}) };
  }

  get(ns: Namespace, oldId: string): string | undefined {
    return this.data[ns][oldId];
  }

  has(ns: Namespace, oldId: string): boolean {
    return oldId in this.data[ns];
  }

  set(ns: Namespace, oldId: string, newId: string): void {
    this.data[ns][oldId] = newId;
    this.persist();
  }

  setMany(ns: Namespace, entries: Array<[string, string]>): void {
    for (const [oldId, newId] of entries) this.data[ns][oldId] = newId;
    this.persist();
  }

  /** Persistence hook. No-op in memory; FileIdMap overrides to write to disk. */
  protected persist(): void {}
}
