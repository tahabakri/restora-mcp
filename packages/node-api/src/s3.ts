/**
 * S3-compatible backup destination — AWS Signature V4 signed by hand (node:crypto + fetch), NO SDK, so the
 * CLI stays a single-file zero-dep bundle. One implementation covers Amazon S3, Backblaze B2, Cloudflare R2,
 * Wasabi, and DigitalOcean Spaces. The user brings their own bucket + keys (stored locally only), so there
 * is no Restora-side OAuth app — fully "your own storage, accessible without us".
 *
 * NOTE: unlike Google Drive (soft-trash), S3 retention is a HARD delete. Enable bucket versioning if you
 * want recoverability — the CLI tells the user this at connect time.
 */
import { createHash, createHmac } from "node:crypto";
import { selectStale, type RetentionPolicy } from "./retention.js";

export interface S3Config {
  provider?: string; // preset id, display only
  endpoint: string; // base, e.g. https://s3.us-east-1.amazonaws.com
  region: string;
  bucket: string;
  prefix?: string; // key prefix, default "restora/"
  pathStyle?: boolean; // virtual-hosted (false) vs path-style (true)
  accessKeyId: string;
  secretAccessKey: string;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sha256hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 percent-encoding, byte-wise. `encodeSlash=false` keeps "/" for path segments. */
function uriEncode(str: string, encodeSlash = true): string {
  let out = "";
  for (const b of Buffer.from(str, "utf8")) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c;
    else if (c === "/" && !encodeSlash) out += c;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export interface SigV4Input {
  method: string;
  canonicalUri: string; // already-encoded path, starts with "/"
  query: Record<string, string>; // unencoded
  headers: Record<string, string>; // must include host, x-amz-date, x-amz-content-sha256
  payloadHashHex: string;
  region: string;
  service?: string; // default "s3"
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
}

/**
 * Build the SigV4 `Authorization` header value. Exported so it can be unit-tested against AWS's published
 * known-answer vectors (deterministic, no network).
 */
export function sigv4Authorization(i: SigV4Input): string {
  const service = i.service ?? "s3";
  const date = i.amzDate.slice(0, 8);

  const canonicalQuery = Object.keys(i.query)
    .map((k) => [uriEncode(k), uriEncode(i.query[k] ?? "")] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers)) lc[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const names = Object.keys(lc).sort();
  const canonicalHeaders = names.map((h) => `${h}:${lc[h]}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [i.method, i.canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadHashHex].join("\n");
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  const kSigning = hmac(hmac(hmac(hmac("AWS4" + i.secretAccessKey, date), i.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function amzDateNow(): string {
  // 2026-06-25T12:34:56.789Z → 20260625T123456Z
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** Issue one signed S3 request. `key=""` targets the bucket itself (e.g. ListObjectsV2).
 *  `opts.stream` sends the body FROM DISK (O(1) memory): SigV4 signs the precomputed sha256 (AWS has
 *  no unsigned-payload for a plain PUT, so the hash is streamed over the file beforehand), and a fresh
 *  read stream is opened per call — safe to retry. */
async function s3Request(
  s3: S3Config,
  method: string,
  key: string,
  opts: {
    query?: Record<string, string>;
    body?: Buffer;
    contentType?: string;
    stream?: { path: string; size: number; sha256hex: string; start?: number; end?: number };
  } = {},
): Promise<Response> {
  const base = new URL(s3.endpoint);
  const pathStyle = s3.pathStyle ?? false;
  const encKey = key ? key.split("/").map((s) => uriEncode(s)).join("/") : "";

  let host: string;
  let canonicalUri: string;
  if (pathStyle) {
    host = base.host;
    canonicalUri = "/" + uriEncode(s3.bucket) + (key ? "/" + encKey : "");
  } else {
    host = `${s3.bucket}.${base.host}`;
    canonicalUri = "/" + encKey;
  }
  const query = opts.query ?? {};
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k] ?? "")}`)
    .join("&");
  const fullUrl = `${base.protocol}//${host}${canonicalUri}${qs ? "?" + qs : ""}`;

  const body = opts.body ?? Buffer.alloc(0);
  const payloadHashHex = opts.stream ? opts.stream.sha256hex : body.length ? sha256hex(body) : EMPTY_SHA256;
  const amzDate = amzDateNow();

  // `host` is signed but NOT sent explicitly — undici derives it from the URL (same value), avoiding the
  // "can't set host header" restriction. Everything else signed is sent verbatim.
  const signedHeaders: Record<string, string> = { host, "x-amz-content-sha256": payloadHashHex, "x-amz-date": amzDate };
  if (opts.contentType) signedHeaders["content-type"] = opts.contentType;

  const authorization = sigv4Authorization({
    method,
    canonicalUri,
    query,
    headers: signedHeaders,
    payloadHashHex,
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    amzDate,
  });

  const sendHeaders: Record<string, string> = {
    "x-amz-content-sha256": payloadHashHex,
    "x-amz-date": amzDate,
    authorization,
  };
  if (opts.contentType) sendHeaders["content-type"] = opts.contentType;
  if (opts.stream) {
    // Stream the file from disk. content-length is required by S3 for a plain PUT (it is NOT part of
    // the SigV4 canonical headers above, so setting it here doesn't affect the signature).
    sendHeaders["content-length"] = String(opts.stream.size);
    const { createReadStream } = await import("node:fs");
    const { Readable } = await import("node:stream");
    // For a multipart UploadPart, stream only this part's byte range from disk (start/end inclusive) —
    // still O(1) memory. A plain PUT omits start/end and streams the whole file.
    const readRange = opts.stream.start !== undefined ? { start: opts.stream.start, end: opts.stream.end } : {};
    // Readable.toWeb's ReadableStream is nominally distinct from undici's — cast; duplex:"half" is
    // required by undici for streamed request bodies (and is in Node 20's fetch typings).
    return fetch(fullUrl, {
      method,
      headers: sendHeaders,
      body: Readable.toWeb(createReadStream(opts.stream.path, readRange)) as unknown as RequestInit["body"],
      duplex: "half",
    });
  }
  return fetch(fullUrl, { method, headers: sendHeaders, body: body.length ? body : undefined });
}

/** sha256 of a file (or a byte range of it), streamed (O(1) memory) — the signable payload hash for a
 *  from-disk PUT / UploadPart. `end` is INCLUSIVE (Node createReadStream convention). */
async function sha256File(path: string, start?: number, end?: number): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  const stream = start !== undefined ? createReadStream(path, { start, end }) : createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// A single S3 PutObject caps at 5 GB (AWS + every S3-compatible provider). Above ~4.5 GB we switch to
// a MULTIPART upload — the object is sent as parts, each ≤5 GB, then combined server-side. Part size is
// 256 MB (streamed from disk per part → O(1) memory), giving up to 256 MB × 10,000 parts ≈ 2.5 TB.
const MULTIPART_THRESHOLD = 4.5 * 1024 * 1024 * 1024;
const PART_SIZE = 256 * 1024 * 1024;

async function createMultipart(s3: S3Config, key: string, contentType: string): Promise<string> {
  const res = await s3Request(s3, "POST", key, { query: { uploads: "" }, contentType });
  if (!res.ok) throw new Error(`S3 start-upload failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const id = /<UploadId>([\s\S]*?)<\/UploadId>/.exec(await res.text())?.[1];
  if (!id) throw new Error("S3 multipart upload: no UploadId returned.");
  return id;
}

/** Upload one part (byte range [start,end], inclusive), retrying transient failures. Returns its ETag. */
async function uploadPart(
  s3: S3Config,
  key: string,
  uploadId: string,
  partNumber: number,
  filePath: string,
  start: number,
  end: number,
): Promise<string> {
  const size = end - start + 1;
  const hashHex = await sha256File(filePath, start, end);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
    try {
      const res = await s3Request(s3, "PUT", key, {
        query: { partNumber: String(partNumber), uploadId },
        stream: { path: filePath, size, sha256hex: hashHex, start, end },
      });
      if (res.ok) {
        const etag = res.headers.get("etag");
        if (!etag) throw new Error(`S3 UploadPart ${partNumber}: no ETag returned.`);
        return etag;
      }
      throw new Error(`S3 UploadPart ${partNumber} failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`S3 UploadPart ${partNumber} failed after retries.`);
}

async function completeMultipart(
  s3: S3Config,
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
): Promise<void> {
  const xml =
    "<CompleteMultipartUpload>" +
    parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("") +
    "</CompleteMultipartUpload>";
  const res = await s3Request(s3, "POST", key, { query: { uploadId }, body: Buffer.from(xml, "utf8"), contentType: "application/xml" });
  const text = await res.text();
  if (!res.ok) throw new Error(`S3 complete-upload failed ${res.status}: ${text.slice(0, 300)}`);
  // S3 can return HTTP 200 with an <Error> body when the combine fails — treat that as a failure too.
  if (/<Error>/.test(text)) throw new Error(`S3 complete-upload error: ${text.slice(0, 300)}`);
}

async function abortMultipart(s3: S3Config, key: string, uploadId: string): Promise<void> {
  try {
    await s3Request(s3, "DELETE", key, { query: { uploadId } });
  } catch {
    /* best-effort cleanup — the incomplete upload will also age out via a bucket lifecycle rule */
  }
}

/** Upload one object FROM DISK, streaming the body (see s3Request stream mode). Small/medium files go as
 *  a single PUT; files over the 5 GB single-PUT ceiling use a multipart upload (fixes "EntityTooLarge").
 *  Retries like s3Put; each attempt re-signs (fresh x-amz-date) and opens a fresh read stream. */
export async function s3PutStream(s3: S3Config, key: string, filePath: string, contentType: string): Promise<void> {
  const { stat } = await import("node:fs/promises");
  const size = (await stat(filePath)).size;

  // Large file → multipart. Send each 256 MB range as a part, then combine.
  if (size > MULTIPART_THRESHOLD) {
    const uploadId = await createMultipart(s3, key, contentType);
    try {
      const parts: Array<{ partNumber: number; etag: string }> = [];
      let partNumber = 1;
      for (let start = 0; start < size; start += PART_SIZE) {
        const end = Math.min(start + PART_SIZE, size) - 1;
        const etag = await uploadPart(s3, key, uploadId, partNumber, filePath, start, end);
        parts.push({ partNumber, etag });
        partNumber++;
      }
      await completeMultipart(s3, key, uploadId, parts);
    } catch (e) {
      await abortMultipart(s3, key, uploadId);
      throw e;
    }
    return;
  }

  // Small/medium file → single streamed PUT (unchanged).
  const hashHex = await sha256File(filePath);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
    try {
      const res = await s3Request(s3, "PUT", key, { contentType, stream: { path: filePath, size, sha256hex: hashHex } });
      if (res.ok) return;
      throw new Error(`S3 upload failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("S3 upload failed after retries.");
}

/** Download one object's raw bytes by key (used to fetch a chosen backup for restore/compare, or a
 *  manifest sidecar). A single signed GET — no retry loop (this is the read side; callers decide how
 *  to handle a failure, e.g. a clean "couldn't download" error). Throws a friendly message on non-2xx,
 *  mirroring the 403/404 hints verifyS3 gives at connect time. */
export async function s3GetObject(s3: S3Config, key: string): Promise<Buffer> {
  const res = await s3Request(s3, "GET", key, {});
  if (res.status === 403) {
    throw new Error("Access denied (403) — the saved key can't read this object. Reconnect S3 with GetObject permission.");
  }
  if (res.status === 404) throw new Error("That backup is no longer in your bucket (404).");
  if (!res.ok) throw new Error(`S3 download failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Raw signed GET returning the Response with its body UNCONSUMED — for streaming readers
 *  (stream-download.ts) that must never buffer a multi-GB object. Callers check res.ok. */
export async function s3Get(s3: S3Config, key: string): Promise<Response> {
  return s3Request(s3, "GET", key, {});
}

/** Signed HEAD — object metadata (size via content-length) without downloading a byte. */
export async function s3Head(s3: S3Config, key: string): Promise<Response> {
  return s3Request(s3, "HEAD", key, {});
}

/** Check the bucket is reachable + the key works, with friendly errors. Throws on failure. */
export async function verifyS3(s3: S3Config): Promise<void> {
  const res = await s3Request(s3, "GET", "", { query: { "list-type": "2", "max-keys": "1" } });
  if (res.status === 403) {
    throw new Error("Access denied (403) — check the access key/secret and that it can ListBucket on this bucket.");
  }
  if (res.status === 404) throw new Error("Bucket not found (404) — check the bucket name, region, and endpoint.");
  if (!res.ok) throw new Error(`S3 check failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Upload one object, retrying transient failures (final step of an unattended scheduled run). */
export async function s3Put(s3: S3Config, key: string, bytes: Buffer, contentType: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
    try {
      const res = await s3Request(s3, "PUT", key, { body: bytes, contentType });
      if (res.ok) return;
      throw new Error(`S3 upload failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("S3 upload failed after retries.");
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** List backup objects under the configured prefix, NEWEST-FIRST. Parses the ListObjectsV2 XML + paginates. */
export async function s3List(s3: S3Config): Promise<Array<{ key: string; time: number }>> {
  const prefix = s3.prefix ?? "restora/";
  const out: Array<{ key: string; time: number }> = [];
  let token: string | undefined;
  for (let page = 0; page < 50; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
    if (token) query["continuation-token"] = token;
    const res = await s3Request(s3, "GET", "", { query });
    if (!res.ok) throw new Error(`S3 list failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const block = m[1] ?? "";
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
      const lm = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1];
      if (key) out.push({ key: decodeXml(key), time: lm ? new Date(lm).getTime() : Date.now() });
    }
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
    token = truncated ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
    if (!token) break;
  }
  out.sort((a, b) => b.time - a.time); // newest first
  return out;
}

/** Permanently delete one object. Returns true on success (404 counts as already-gone). */
export async function s3Delete(s3: S3Config, key: string): Promise<boolean> {
  const res = await s3Request(s3, "DELETE", key, {});
  return res.ok || res.status === 404;
}

/** Apply the retention policy to the bucket (HARD delete on S3). Never throws; returns how many it deleted. */
export async function s3Retain(s3: S3Config, policy: RetentionPolicy): Promise<number> {
  let files: Array<{ key: string; time: number }>;
  try {
    files = await s3List(s3);
  } catch {
    return 0; // couldn't list — skip cleanup; the backup itself already succeeded
  }
  const stale = selectStale(files, policy);
  let deleted = 0;
  for (const f of stale) {
    try {
      if (await s3Delete(s3, f.key)) deleted++;
    } catch {
      /* skip — cleanup must never fail the run */
    }
  }
  return deleted;
}
