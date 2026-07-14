/**
 * Thin, original Notion API client.
 *
 * Why hand-rolled instead of @notionhq/client:
 *  - Auditable for a privacy tool (no transitive deps, you can read every byte).
 *  - Cloudflare-Worker-native (uses global `fetch`, no Node-only APIs) so Phase 1
 *    reuses this file verbatim.
 *  - Full control over the brand-new /v1/views endpoints.
 *
 * It owns the three things every Notion integration gets wrong:
 *  1. Rate limiting   — Notion allows ~3 req/s average. We serialize at ~2.5 req/s.
 *  2. Backoff         — on HTTP 429 and 529 we honor the Retry-After header.
 *  3. Pagination      — list endpoints return at most 100 items + a cursor.
 *
 * All requests send `Notion-Version: 2026-03-11`.
 */

export const NOTION_VERSION = "2026-03-11";
const BASE_URL = "https://api.notion.com";

/** Stay under Notion's ~3 req/s average. 400ms => 2.5 req/s. */
const MIN_REQUEST_INTERVAL_MS = 400;
const MAX_RETRIES = 6;

export interface NotionListResponse<T = JsonObject> {
  object: "list";
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "NotionError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Supplies the bearer token per request. Long server-side runs (multi-hour backups/restores) outlive
 * Notion's ~60-minute access tokens — a provider lets the caller refresh mid-run. `forceRefresh` is
 * set when the previous attempt got a 401 with this token, so the provider must fetch a fresh one
 * (not return its cache). Static-token construction still works everywhere (browser session, CLI).
 */
export type NotionTokenProvider = (opts?: { forceRefresh?: boolean }) => string | Promise<string>;

export class NotionClient {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = 0;
  private readonly provider: NotionTokenProvider;
  /** True when a provider was supplied — only then is a 401 worth one refresh-and-retry. */
  private readonly canRefresh: boolean;

  constructor(token: string | NotionTokenProvider) {
    if (!token) throw new Error("NotionClient requires a token.");
    this.canRefresh = typeof token !== "string";
    this.provider = typeof token === "string" ? () => token : token;
  }

  /**
   * Serialize every request through a single FIFO gate with a minimum spacing
   * between dispatches. Concurrency of 1 is deliberate: it makes the ~3 req/s
   * limit trivially correct and keeps restore ordering deterministic.
   */
  private gate<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = this.lastStart + MIN_REQUEST_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();
      return fn();
    });
    // Keep the chain alive regardless of success/failure of this request.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async request<T = JsonObject>(
    method: string,
    path: string,
    body?: JsonObject,
  ): Promise<T> {
    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    let lastErr: unknown;
    // Set when the previous attempt 401'd: the next provider call must fetch a FRESH token (a
    // multi-hour run outlives Notion's ~60-minute access tokens). ONE refresh per request — a
    // second 401 after a fresh token means real revocation and throws below.
    let forceRefresh = false;
    let refreshTried = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Resolve the bearer OUTSIDE the gate so a slow refresh doesn't distort request spacing.
      const bearer = await this.provider(forceRefresh ? { forceRefresh: true } : undefined);
      forceRefresh = false;
      let res: Response;
      try {
        res = await this.gate(() =>
          fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${bearer}`,
              "Notion-Version": NOTION_VERSION,
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
          }),
        );
      } catch (networkErr) {
        // Transient network failure — back off and retry.
        lastErr = networkErr;
        if (attempt === MAX_RETRIES) break;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }

      const errBody = await safeJson(res);
      const code = (errBody as JsonObject | undefined)?.code as string | undefined;
      const message =
        ((errBody as JsonObject | undefined)?.message as string | undefined) ??
        res.statusText;

      // 401 with a refresh-capable provider: the access token likely expired mid-run — force one
      // fresh token and retry. Not counted as "retryable" below (a static token can't heal a 401).
      if (res.status === 401 && this.canRefresh && !refreshTried && attempt < MAX_RETRIES) {
        forceRefresh = true;
        refreshTried = true;
        lastErr = new NotionError(message, res.status, code, errBody);
        continue;
      }

      // 429 (rate limited) and 529 (overloaded) — honor Retry-After.
      // 5xx — transient, back off.
      const retryable =
        res.status === 429 || res.status === 529 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000 + 250
          : backoffMs(attempt);
        await sleep(waitMs);
        lastErr = new NotionError(message, res.status, code, errBody);
        continue;
      }

      throw new NotionError(
        `Notion API ${res.status} ${code ?? ""}: ${message}`.trim(),
        res.status,
        code,
        errBody,
      );
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Notion request failed after ${MAX_RETRIES} retries: ${path}`);
  }

  /** Collect every item across a paginated list endpoint. */
  private async collect<T>(
    fetchPage: (cursor: string | undefined) => Promise<NotionListResponse<T>>,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetchPage(cursor);
      out.push(...page.results);
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }

  // The convenience methods below return `any` and accept loose bodies on purpose:
  // they shuttle Notion's large, frequently-changing JSON shapes, which we treat as
  // opaque. Typing every Notion object would be brittle without adding real safety.

  // ---- Connection -------------------------------------------------------

  /** GET /v1/users/me — used by "Test connection". Returns the bot user. */
  getSelf(): Promise<any> {
    return this.request("GET", "/v1/users/me");
  }

  // ---- Search -----------------------------------------------------------

  /**
   * POST /v1/search across all pages. Under 2025-09-03+ the searchable object types
   * are "page" and "data_source" (no "database"); a data_source result carries its
   * containing database via parent.database_id.
   */
  searchAll(body: Record<string, any> = {}): Promise<any[]> {
    return this.collect<any>((cursor) =>
      this.request<NotionListResponse>("POST", "/v1/search", {
        ...body,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    );
  }

  // ---- Databases & data sources ----------------------------------------

  createDatabase(body: Record<string, any>): Promise<any> {
    return this.request("POST", "/v1/databases", body);
  }

  getDatabase(databaseId: string): Promise<any> {
    return this.request("GET", `/v1/databases/${databaseId}`);
  }

  createDataSource(body: Record<string, any>): Promise<any> {
    return this.request("POST", "/v1/data_sources", body);
  }

  getDataSource(dataSourceId: string): Promise<any> {
    return this.request("GET", `/v1/data_sources/${dataSourceId}`);
  }

  /** PATCH a data source schema (e.g. add relation/rollup properties later). */
  updateDataSource(dataSourceId: string, body: Record<string, any>): Promise<any> {
    return this.request("PATCH", `/v1/data_sources/${dataSourceId}`, body);
  }

  /** Query all pages in a data source, following pagination. */
  queryDataSourceAll(dataSourceId: string, body: Record<string, any> = {}): Promise<any[]> {
    return this.collect<any>((cursor) =>
      this.request<NotionListResponse>(
        "POST",
        `/v1/data_sources/${dataSourceId}/query`,
        { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      ),
    );
  }

  /**
   * One bounded page of a data source's rows — a single request, no pagination. For cheap
   * presence/sampling checks (e.g. "does this data source still have any rows?") where downloading
   * the whole table would be far too many calls. Returns the first page's rows + whether more exist.
   */
  async queryDataSourceFirstPage(
    dataSourceId: string,
    pageSize = 1,
  ): Promise<{ results: any[]; has_more: boolean }> {
    const page = await this.request<NotionListResponse>(
      "POST",
      `/v1/data_sources/${dataSourceId}/query`,
      { page_size: pageSize },
    );
    return { results: page.results, has_more: page.has_more };
  }

  // ---- Pages & blocks ---------------------------------------------------

  createPage(body: Record<string, any>): Promise<any> {
    return this.request("POST", "/v1/pages", body);
  }

  updatePage(pageId: string, body: Record<string, any>): Promise<any> {
    return this.request("PATCH", `/v1/pages/${pageId}`, body);
  }

  getPage(pageId: string): Promise<any> {
    return this.request("GET", `/v1/pages/${pageId}`);
  }

  /**
   * Retrieve a page property item, paginated. Used to recover the FULL list of related
   * page ids for a relation property — query/page-retrieve responses cap relations at 25
   * (with has_more=true on the value), so this is the only complete source. Returns the
   * related page ids. propertyId is normalized (Notion returns ids URL-encoded; we decode
   * then re-encode so the path is correct whether the caller passes the encoded or raw id).
   */
  async getPagePropertyItemAll(pageId: string, propertyId: string): Promise<string[]> {
    let decoded = propertyId;
    try {
      decoded = decodeURIComponent(propertyId);
    } catch {
      decoded = propertyId;
    }
    const enc = encodeURIComponent(decoded);
    const items = await this.collect<any>((cursor) =>
      this.request<NotionListResponse>(
        "GET",
        `/v1/pages/${pageId}/properties/${enc}?page_size=100${
          cursor ? `&start_cursor=${cursor}` : ""
        }`,
      ),
    );
    return items.map((it) => it?.relation?.id).filter((id): id is string => typeof id === "string");
  }

  /** Direct (first-level) children of a block/page. Recurse on has_children. */
  getBlockChildrenAll(blockId: string): Promise<any[]> {
    return this.collect<any>((cursor) =>
      this.request<NotionListResponse>(
        "GET",
        `/v1/blocks/${blockId}/children?page_size=100${
          cursor ? `&start_cursor=${cursor}` : ""
        }`,
      ),
    );
  }

  /** Append up to 100 child blocks. Caller is responsible for chunking. */
  appendBlockChildren(blockId: string, children: any[]): Promise<any> {
    return this.request("PATCH", `/v1/blocks/${blockId}/children`, { children });
  }

  /**
   * All comments on a page/block, following pagination. Read-only and archival: the Notion API
   * can't recreate comments on restore, so these are captured for the record, not replayed.
   */
  listCommentsAll(blockId: string): Promise<any[]> {
    return this.collect<any>((cursor) =>
      this.request<NotionListResponse>(
        "GET",
        `/v1/comments?block_id=${blockId}&page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
      ),
    );
  }

  // ---- Views (2026-03-11) ----------------------------------------------

  listViewsAll(dataSourceId: string): Promise<any[]> {
    return this.collect<any>((cursor) =>
      this.request<NotionListResponse>(
        "GET",
        `/v1/views?data_source_id=${dataSourceId}&page_size=100${
          cursor ? `&start_cursor=${cursor}` : ""
        }`,
      ),
    );
  }

  getView(viewId: string): Promise<any> {
    return this.request("GET", `/v1/views/${viewId}`);
  }

  createView(body: Record<string, any>): Promise<any> {
    return this.request("POST", "/v1/views", body);
  }

  updateView(viewId: string, body: Record<string, any>): Promise<any> {
    return this.request("PATCH", `/v1/views/${viewId}`, body);
  }

  deleteView(viewId: string): Promise<any> {
    return this.request("DELETE", `/v1/views/${viewId}`);
  }

  // ---- File uploads (2026 File Upload API) ------------------------------
  // 3-stage: create a slot → send the bytes (multipart) → attach the returned id within 1 hour
  // via {type:"file_upload", file_upload:{id}} on an icon/cover/files-property/image-or-file block.

  /** Create an upload slot. single_part is ≤20MB; multi_part needs number_of_parts (5–20MB per part,
   *  the last may be smaller). Returns { id, status, … }. */
  createFileUpload(opts: { mode?: "single_part" | "multi_part"; number_of_parts?: number; filename?: string; content_type?: string } = {}): Promise<any> {
    return this.request("POST", "/v1/file_uploads", {
      mode: opts.mode ?? "single_part",
      ...(opts.number_of_parts ? { number_of_parts: opts.number_of_parts } : {}),
      ...(opts.filename ? { filename: opts.filename } : {}),
      ...(opts.content_type ? { content_type: opts.content_type } : {}),
    });
  }

  /**
   * Send the bytes for a created upload as multipart/form-data field "file". Crucially does NOT
   * set Content-Type — fetch must generate the multipart boundary itself. Same gate + retry as
   * request(). Returns the upload object (status "uploaded" on success).
   */
  async sendFileUpload(fileUploadId: string, bytes: Uint8Array, filename: string, contentType?: string, partNumber?: number): Promise<any> {
    const path = `/v1/file_uploads/${fileUploadId}/send`;
    let lastErr: unknown;
    let forceRefresh = false;
    let refreshTried = false;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Rebuild the FormData each attempt — a Blob/stream body can't be re-sent after a failed fetch.
      const form = new FormData();
      // Cast to a concrete ArrayBuffer-backed view: a Uint8Array is always a valid Blob part at runtime,
      // and this sidesteps TS 5.7's typed-array generics (Uint8Array<ArrayBufferLike> isn't assignable to
      // the DOM/Node Blob-part type). Valid + assignable under workers-types, Node, and DOM libs alike.
      const part = bytes as Uint8Array<ArrayBuffer>;
      form.append("file", new Blob([part], contentType ? { type: contentType } : undefined), filename);
      if (partNumber != null) form.append("part_number", String(partNumber)); // multi-part only
      const bearer = await this.provider(forceRefresh ? { forceRefresh: true } : undefined);
      forceRefresh = false;
      let res: Response;
      try {
        res = await this.gate(() =>
          fetch(`${BASE_URL}${path}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${bearer}`, "Notion-Version": NOTION_VERSION },
            body: form,
          }),
        );
      } catch (networkErr) {
        lastErr = networkErr;
        if (attempt === MAX_RETRIES) break;
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as any;
      const errBody = await safeJson(res);
      const code = (errBody as JsonObject | undefined)?.code as string | undefined;
      const message = ((errBody as JsonObject | undefined)?.message as string | undefined) ?? res.statusText;
      // Mid-run token expiry — same one-refresh-then-retry contract as request().
      if (res.status === 401 && this.canRefresh && !refreshTried && attempt < MAX_RETRIES) {
        forceRefresh = true;
        refreshTried = true;
        lastErr = new NotionError(message, res.status, code, errBody);
        continue;
      }
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 + 250 : backoffMs(attempt));
        lastErr = new NotionError(message, res.status, code, errBody);
        continue;
      }
      throw new NotionError(`Notion API ${res.status} ${code ?? ""}: ${message}`.trim(), res.status, code, errBody);
    }
    throw lastErr instanceof Error ? lastErr : new Error(`File upload send failed after ${MAX_RETRIES} retries`);
  }

  /** Finalize a multi-part upload after every part has been sent. */
  completeFileUpload(fileUploadId: string): Promise<any> {
    return this.request("POST", `/v1/file_uploads/${fileUploadId}/complete`);
  }

  /**
   * Convenience: create + send → the file_upload id, ready to attach (within 1 hour). Files ≤20MB use
   * single-part; larger files use Notion's multi-part flow (create → send each ~10MB part → complete).
   * NOTE: multi-part requires a PAID Notion workspace; a free workspace's per-file limit makes Notion
   * reject the create/complete with a 400 validation_error, surfaced as a NotionError for the caller.
   */
  async uploadFile(bytes: Uint8Array, filename: string, contentType?: string): Promise<string> {
    const SINGLE_PART_MAX = 20 * 1024 * 1024;
    if (bytes.length <= SINGLE_PART_MAX) {
      const created = await this.createFileUpload({ filename, content_type: contentType });
      const sent = await this.sendFileUpload(created.id, bytes, filename, contentType);
      if (sent.status !== "uploaded") {
        throw new NotionError(`file upload did not complete (status ${sent.status})`, 0, "upload_incomplete", sent);
      }
      return created.id as string;
    }
    // Multi-part: fixed 10MB parts (Notion requires 5–20MB per part; the final part may be smaller).
    const PART_SIZE = 10 * 1024 * 1024;
    const numberOfParts = Math.ceil(bytes.length / PART_SIZE);
    const created = await this.createFileUpload({ mode: "multi_part", number_of_parts: numberOfParts, filename, content_type: contentType });
    for (let i = 0; i < numberOfParts; i++) {
      const chunk = bytes.subarray(i * PART_SIZE, Math.min((i + 1) * PART_SIZE, bytes.length));
      await this.sendFileUpload(created.id, chunk, filename, contentType, i + 1);
    }
    const done = await this.completeFileUpload(created.id);
    if (done.status !== "uploaded") {
      throw new NotionError(`multi-part upload did not complete (status ${done.status})`, 0, "upload_incomplete", done);
    }
    return created.id as string;
  }
}

function backoffMs(attempt: number): number {
  // Exponential backoff with jitter, capped at ~16s.
  const base = Math.min(16000, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
