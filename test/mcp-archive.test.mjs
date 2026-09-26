/**
 * Restora MCP reads format-3 backups truthfully (archived rows), and v1/v2 answers are unchanged.
 *
 * Drives the REAL built server (dist/restora-mcp.js) over stdio JSON-RPC, exactly as an agent does:
 *   1. v1/v2: every tool's answer is byte-identical to test/fixtures/v1v2-baseline.json (re-recorded
 *      2026-09-26 when answers became compact JSON), AND has exactly the keys and values of the 0.3.0
 *      server's (03ab1b2) answers in test/fixtures/v1v2-baseline-0.3.0.json — the only change since is
 *      the serialization, plus list_backups' `workspace` field;
 *   2. v3: a relation to a CAPTURED archived row names it "(archived)" — never "(not in this backup)";
 *      get_page opens it and says it's an archived row; unknown / unavailable / inconsistent targets
 *      are never invented; query_database and search stay live-only; the archive states are the app's;
 *   3. a newer format is refused with a clear message; nothing in the MCP writes format 3;
 *   4. the mirrored readers are byte-identical to the Restora app (sibling ../Notion_back, if present).
 *
 *   npm test                                         (builds, then runs this)
 *   node test/mcp-archive.test.mjs --record <dist>   (re-record the baseline from another build)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist", "restora-mcp.js");
const BASELINE = join(ROOT, "test", "fixtures", "v1v2-baseline.json");
const BASELINE_030 = join(ROOT, "test", "fixtures", "v1v2-baseline-0.3.0.json");
const recordFrom = process.argv[2] === "--record" ? resolve(process.argv[3] ?? "") : null;

let ok = true;
let n = 0;
const check = (cond, msg) => {
  n++;
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) ok = false;
};

// ---- fixtures ----------------------------------------------------------------------------------------
//   db1/dsP Projects   P1 → [T1, TA1], P2 → [T-gone]         archived: PA1 → [T1]
//   db2/dsT Tasks      T1 → Project [PA1], Ref [U-missing]    archived: TA1
//   db3/dsU Unlisted   U1                                      archived partition: couldn't be listed
//   db4/dsV Contradict V1 → [VA1]                              archived entry: VA1 + a copy of live V1
//   page  SP Home
const tx = (s) => [{ type: "text", plain_text: s, text: { content: s } }];
const row = (id, title, props = {}) => ({
  id,
  properties: { Name: { type: "title", title: tx(title) }, ...props },
  blocks: [{ id: `${id}-b`, type: "paragraph", paragraph: { rich_text: tx(`${title} body`) } }],
});
const rel = (...ids) => ({ type: "relation", relation: ids.map((id) => ({ id })) });
const relTo = (ds, db) => ({ type: "relation", relation: { data_source_id: ds, database_id: db, type: "single_property", single_property: {} } });
const NAME = { type: "title", title: {} };
const ds = (id, name, props, pages) => ({ id, name, views: [], properties: { Name: NAME, ...props }, pages });
const entry = (databaseId, dataSourceId, state, extra = {}) => ({ databaseId, dataSourceId, state, ...extra });
const section = (capability, dataSources) => ({ v: 1, capability, dataSources });
function backup(formatVersion, archive) {
  return {
    formatVersion,
    notionVersion: "2026-03-11",
    createdAt: "2026-09-25T00:00:00.000Z",
    databases: [
      { id: "db1", title: "Projects", dataSources: [ds("dsP", "Projects", { Tasks: relTo("dsT", "db2") }, [row("P1", "Live Project One", { Tasks: rel("T1", "TA1") }), row("P2", "Live Project Two", { Tasks: rel("T-gone") })])] },
      { id: "db2", title: "Tasks", dataSources: [ds("dsT", "Tasks", { Project: relTo("dsP", "db1"), Ref: relTo("dsU", "db3") }, [row("T1", "Live Task One", { Project: rel("PA1"), Ref: rel("U-missing") })])] },
      { id: "db3", title: "Unlisted", dataSources: [ds("dsU", "Unlisted", {}, [row("U1", "Live U")])] },
      { id: "db4", title: "Contradicted", dataSources: [ds("dsV", "Contradicted", { Link: relTo("dsV", "db4") }, [row("V1", "Live V", { Link: rel("VA1") })])] },
    ],
    pages: [{ id: "SP", parent: { type: "workspace" }, title: tx("Home"), blocks: [{ id: "SP-b", type: "paragraph", paragraph: { rich_text: tx("Welcome home") } }] }],
    ...(archive !== undefined ? { archive } : {}),
  };
}
const PROVEN = section("proven", [
  entry("db1", "dsP", "captured", { pages: [row("PA1", "Archived Project Alpha", { Tasks: rel("T1") })] }),
  entry("db2", "dsT", "captured", { pages: [row("TA1", "Archived Task Alpha")] }),
  entry("db3", "dsU", "unavailable", { reason: "query_incomplete" }),
  entry("db4", "dsV", "captured", { pages: [row("VA1", "Archived V"), row("V1", "Live V")] }),
]);
const UNPROVEN = section("unproven", [entry("db1", "dsP", "empty"), entry("db2", "dsT", "empty"), entry("db3", "dsU", "unavailable", { reason: "failed" }), entry("db4", "dsV", "empty")]);
const FILES = {
  "notion-backup-2026-09-21T00-00-00-000Z.json": { ...backup(2), formatVersion: 1 },
  "notion-backup-2026-09-22T00-00-00-000Z.json": backup(2),
  "notion-backup-2026-09-23T00-00-00-000Z.json": backup(3, PROVEN),
  "notion-backup-2026-09-24T00-00-00-000Z.json": backup(3, UNPROVEN),
  "notion-backup-2026-09-24T12-00-00-000Z.json": backup(3, { ...PROVEN, capability: "maybe" }),
  "notion-backup-2026-09-25T00-00-00-000Z.json": { ...backup(2), formatVersion: 4 },
};
const V1 = "notion-backup-2026-09-21T00-00-00-000Z.json";
const V2 = "notion-backup-2026-09-22T00-00-00-000Z.json";
const V3 = "notion-backup-2026-09-23T00-00-00-000Z.json";
const V3_UNKNOWN = "notion-backup-2026-09-24T00-00-00-000Z.json";
const V3_MALFORMED = "notion-backup-2026-09-24T12-00-00-000Z.json";

// ---- a stdio JSON-RPC client for the real server ---------------------------------------------------
function startServer(dist, dir, home) {
  const child = spawn(process.execPath, [dist, "--dir", dir], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const call = (method, params) =>
    new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    call,
    /** A tool's text payload (JSON-parsed when it is JSON) and its error flag. */
    async tool(name, args = {}) {
      const r = (await call("tools/call", { name, arguments: args })).result;
      const text = r.content[0].text;
      let data = text;
      try {
        data = JSON.parse(text);
      } catch {}
      return { text, data, isError: r.isError === true };
    },
    close: () => {
      child.stdin.end();
      return new Promise((r) => child.on("close", r));
    },
  };
}

/** The v1/v2 questions whose answers must never change. */
function v1v2Calls(dir) {
  const calls = [];
  for (const f of [V1, V2]) {
    const path = join(dir, f);
    calls.push([`${f} describe_backup`, "describe_backup", { path }]);
    for (const d of ["dsP", "dsT", "dsV"]) calls.push([`${f} query_database ${d}`, "query_database", { path, dataSourceId: d }]);
    for (const id of ["P1", "T1", "SP", "PA1"]) calls.push([`${f} get_page ${id}`, "get_page", { path, pageId: id }]);
    for (const q of ["Archived", "Live", "home"]) calls.push([`${f} search ${q}`, "search", { path, query: q }]);
  }
  return calls;
}
/** Machine-independent: the temp folder becomes <DIR>, and the separator after it "/" (raw or JSON-escaped). */
const normalize = (text, dir) =>
  text
    .split(JSON.stringify(dir).slice(1, -1))
    .join("<DIR>")
    .split(dir)
    .join("<DIR>")
    .replace(/<DIR>(\\\\|\\|\/)/g, "<DIR>/");

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "restora-mcp-archive-"));
  const home = mkdtempSync(join(tmpdir(), "restora-mcp-home-"));
  try {
    // Distinct mtimes so list_backups' newest-first order is deterministic.
    let t = Date.parse("2026-09-25T00:00:00Z") / 1000;
    for (const [name, json] of Object.entries(FILES)) {
      writeFileSync(join(dir, name), JSON.stringify(json));
      utimesSync(join(dir, name), t, t);
      t += 60;
    }
    const v1v2Dir = mkdtempSync(join(tmpdir(), "restora-mcp-v1v2-"));
    for (const f of [V1, V2]) {
      writeFileSync(join(v1v2Dir, f), JSON.stringify(FILES[f]));
      utimesSync(join(v1v2Dir, f), f === V1 ? 1000 : 2000, f === V1 ? 1000 : 2000);
    }

    if (recordFrom) {
      const srv = startServer(recordFrom, v1v2Dir, home);
      const out = {};
      for (const [label, name, args] of v1v2Calls(v1v2Dir)) out[label] = normalize((await srv.tool(name, args)).text, v1v2Dir);
      out["list_backups"] = normalize((await srv.tool("list_backups")).text, v1v2Dir);
      await srv.close();
      writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n");
      console.log(`recorded ${Object.keys(out).length} answers from ${recordFrom}`);
      rmSync(v1v2Dir, { recursive: true, force: true });
      return;
    }

    console.log("=== 1. v1/v2: every answer is byte-identical to the baseline, and the 0.3.0 server's in content ===");
    {
      const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
      const v030 = JSON.parse(readFileSync(BASELINE_030, "utf8"));
      const srv = startServer(DIST, v1v2Dir, home);
      const answers = {};
      for (const [label, name, args] of v1v2Calls(v1v2Dir)) answers[label] = normalize((await srv.tool(name, args)).text, v1v2Dir);
      answers["list_backups"] = normalize((await srv.tool("list_backups")).text, v1v2Dir);
      await srv.close();
      const drift = Object.keys(answers).filter((label) => answers[label] !== baseline[label]);
      check(drift.length === 0, `${v1v2Calls(v1v2Dir).length + 1} v1/v2 answers (describe, query ×3, get_page ×4, search ×3 per file, list) unchanged${drift.length ? ` — CHANGED: ${drift.join(" | ")}` : ""}`);
      // Content, against the 0.3.0 server: the same keys and values, only compacted — list_backups may add
      // `workspace` (null for these unstamped files). Markdown answers stay byte-identical.
      const parse = (t) => {
        try {
          return JSON.parse(t);
        } catch {
          return undefined;
        }
      };
      const changed = [];
      for (const [label, text] of Object.entries(answers)) {
        const now = parse(text);
        const then = parse(v030[label]);
        if (now === undefined || then === undefined) {
          if (text !== v030[label]) changed.push(label);
          continue;
        }
        if (text !== JSON.stringify(now)) changed.push(`${label} (not compact)`);
        if (label === "list_backups") for (const b of now.backups ?? []) delete b.workspace;
        if (!isDeepStrictEqual(now, then)) changed.push(label);
      }
      check(changed.length === 0, `all ${Object.keys(answers).length} carry the 0.3.0 server's keys and values, compact${changed.length ? ` — DIFFER: ${changed.join(" | ")}` : ""}`);
      rmSync(v1v2Dir, { recursive: true, force: true });
    }

    const srv = startServer(DIST, dir, home);
    const at = (f) => join(dir, f);

    console.log("\n=== 2. v3: relations to captured archived rows resolve and are marked ===");
    {
      const qP = (await srv.tool("query_database", { path: at(V3), dataSourceId: "dsP" })).data;
      const p1 = qP.rows.find((r) => r.id === "P1");
      check(JSON.stringify(p1.props.Tasks) === JSON.stringify(["Live Task One", "Archived Task Alpha (archived)"]), `a live row's relation to a captured archived row names it, marked: ${JSON.stringify(p1.props.Tasks)}`);
      check(!qP.rows.some((r) => r.id === "PA1" || r.id === "TA1"), "…and no archived row is listed as a row (PA1 is this data source's own archived row)");
      check(qP.total === 2 && qP.rows.map((r) => r.id).join(",") === "P1,P2", "query_database stays live-only (P1, P2)");
      check(JSON.stringify(qP.rows.find((r) => r.id === "P2").props.Tasks) === JSON.stringify(["(not in this backup)"]), "a missing target in a data source whose archived rows WERE captured is plainly not in this backup");
      check(qP.archive?.state === "captured" && qP.archive.pageCount === 1 && typeof qP.archive.note === "string", "the data source's archive state is reported (captured, 1 archived row)");
      const qT = (await srv.tool("query_database", { path: at(V3), dataSourceId: "dsT" })).data;
      const t1 = qT.rows[0];
      check(JSON.stringify(t1.props.Project) === JSON.stringify(["Archived Project Alpha (archived)"]), "…in the other direction too");
      check(JSON.stringify(t1.props.Ref) === JSON.stringify(["(not in this backup; archived rows there couldn't be checked)"]), "a target in an UNAVAILABLE partition: not invented, the limitation named");
      const qV = (await srv.tool("query_database", { path: at(V3), dataSourceId: "dsV" })).data;
      check(JSON.stringify(qV.rows[0].props.Link) === JSON.stringify(["(not in this backup; archived rows there can't be trusted)"]) && qV.archive?.state === "inconsistent", "an INCONSISTENT partition (archived copy of a live row) fails closed: nothing resolved from it");
      check(qV.total === 1 && qV.rows[0].id === "V1", "…and its live row stays the live row");
    }

    console.log("\n=== 3. v3: get_page opens a captured archived row — marked — and invents nothing ===");
    {
      const pa1 = await srv.tool("get_page", { path: at(V3), pageId: "PA1" });
      check(!pa1.isError && pa1.text.startsWith("# Archived Project Alpha\n\n_Projects (archived row)_"), "get_page on a captured archived row: its content, with a source line that says it is an archived row");
      check(pa1.text.includes("**Tasks:** Live Task One"), "…its own relations resolve");
      const va1 = await srv.tool("get_page", { path: at(V3), pageId: "VA1" });
      check(va1.isError && /No page VA1 in this backup/.test(va1.text), "an archived row from an inconsistent partition is not opened");
      const unk = await srv.tool("get_page", { path: at(V3_UNKNOWN), pageId: "PA1" });
      check(unk.isError && /No page PA1 in this backup/.test(unk.text), "unknown partition: no archived row is invented");
      const p1 = await srv.tool("get_page", { path: at(V3), pageId: "P1" });
      check(!p1.isError && p1.text.startsWith("# Live Project One\n\n_Projects_") && p1.text.includes("Archived Task Alpha (archived)"), "a live row renders as before, its archived relation named");
    }

    console.log("\n=== 4. v3 unknown / malformed: never zero, never invented ===");
    {
      const q = (await srv.tool("query_database", { path: at(V3_UNKNOWN), dataSourceId: "dsP" })).data;
      check(
        JSON.stringify(q.rows.find((r) => r.id === "P1").props.Tasks) === JSON.stringify(["Live Task One", "(not in this backup; archived rows there weren't confirmed)"]) && q.archive?.state === "unknown",
        "unknown: the missing target stays missing, the limitation named; the state is unknown, not zero",
      );
      const m = (await srv.tool("query_database", { path: at(V3_MALFORMED), dataSourceId: "dsT" })).data;
      check(JSON.stringify(m.rows[0].props.Project) === JSON.stringify(["(not in this backup; archived rows there can't be trusted)"]) && m.archive?.state === "inconsistent", "malformed section: every partition inconsistent, no archived row resolves");
    }

    console.log("\n=== 5. v3: describe, search and list say what they cover ===");
    {
      const d = (await srv.tool("describe_backup", { path: at(V3) })).data;
      const states = Object.fromEntries(d.archive.dataSources.map((x) => [x.dataSourceId, x.state]));
      check(JSON.stringify(states) === JSON.stringify({ dsP: "captured", dsT: "captured", dsU: "unavailable", dsV: "inconsistent" }), `describe_backup: each data source's archived state (${JSON.stringify(states)})`);
      check(d.archive.capturedRows === 2 && d.archive.partitions.unavailable === 1 && d.archive.partitions.inconsistent === 1 && d.pageCount === 5, "…captured archived rows counted apart (2); the live page count unchanged (5)");
      const du = (await srv.tool("describe_backup", { path: at(V3_UNKNOWN) })).data;
      check(du.archive.partitions.unknown === 3 && du.archive.capturedRows === 0 && du.archive.dataSources.find((x) => x.dataSourceId === "dsP").state === "unknown", "unknown partitions are reported as unknown (3), never as zero");
      const s = (await srv.tool("search", { path: at(V3), query: "Archived Project" })).data;
      check(!s.hits.some((h) => h.pageId === "PA1") && s.archive?.archivedRowsNotSearched === 2, "search stays live-only and says how many archived rows it didn't search");
      check(s.hits.some((h) => h.pageId === "T1" && /Archived Project Alpha \(archived\)/.test(h.snippet)), "…a live row that names the archived row is found through its relation");
      const list = (await srv.tool("list_backups")).data;
      const byName = Object.fromEntries(list.backups.map((b) => [b.path.split(/[\\/]/).pop(), b]));
      check(byName[V3].archive?.capturedRows === 2 && byName[V3].pageCount === 5, "list_backups: a v3 entry carries its archive summary beside the live counts");
      check(!("archive" in byName[V2]) && !("archive" in byName[V1]), "…v1/v2 entries carry nothing new");
    }

    console.log("\n=== 6. formats ===");
    {
      const v4 = await srv.tool("describe_backup", { path: at("notion-backup-2026-09-25T00-00-00-000Z.json") });
      check(v4.isError && /newer version of Restora \(format 4\)\. Update Restora to open it\./.test(v4.text), `a format-4 file is refused clearly: ${v4.text}`);
      const list = (await srv.tool("list_backups")).data;
      const v4entry = list.backups.find((b) => b.path.endsWith("2026-09-25T00-00-00-000Z.json"));
      check(v4entry.summary === null && /newer version of Restora/.test(v4entry.note), "…and list_backups names why it can't be summarized");
      check(!(await srv.tool("describe_backup", { path: at(V1) })).isError && !(await srv.tool("describe_backup", { path: at(V3) })).isError, "formats 1, 2 and 3 are read");
    }
    await srv.close();

    console.log("\n=== 7. nothing in the MCP writes format 3 ===");
    {
      const code = [];
      const walk = (d) => {
        for (const e of readdirSync(d)) {
          const p = join(d, e);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.ts$/.test(e)) code.push(p);
        }
      };
      for (const d of ["bin", "cli", "packages", "src"]) walk(join(ROOT, d));
      const lines = code.flatMap((f) =>
        readFileSync(f, "utf8")
          .split(/\r?\n/)
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .map((l) => [f, l]),
      );
      const writes = lines.filter(([, l]) => /formatVersion\s*:\s*(3\b|ARCHIVE_FORMAT_VERSION)|archive(Aware|Proven)\b['"]?\s*(:|=(?!=))/.test(l));
      check(writes.length === 0, `no code writes a format-3 backup or an archive marker${writes.length ? ` — ${writes.map(([f, l]) => `${f}: ${l.trim()}`).join(" | ")}` : ""}`);
      const fileWriters = [...new Set(lines.filter(([, l]) => /\b(writeFile|writeFileSync|createWriteStream)\s*\(/.test(l)).map(([f]) => f.slice(ROOT.length + 1).replace(/\\/g, "/")))];
      check(
        fileWriters.length === 1 && fileWriters[0] === "packages/node-api/src/config.ts",
        `the only file this code can write is the user's own config (packages/node-api/src/config.ts) — never a backup (${fileWriters.join(", ")})`,
      );
    }

    console.log("\n=== 8. the mirrored readers are the Restora app's, byte for byte ===");
    {
      const APP = join(ROOT, "..", "Notion_back");
      const mirrored = ["src/core/backup-query.ts", "src/core/calculated-values.ts", "src/core/render-md.ts", "src/core/archive-state.ts", "src/core/archive-query.ts", "src/notion/types.ts"];
      if (!existsSync(APP)) {
        console.log(`  SKIPPED — no sibling app checkout at ${APP}; the mirror pin did NOT run`);
      } else {
        const lf = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
        for (const rel of mirrored) check(existsSync(join(APP, rel)) && lf(join(ROOT, rel)) === lf(join(APP, rel)), `${rel} — identical to the app`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }

  console.log(ok ? `\n✅ PASS — ${n} checks. v3 archived rows read truthfully; v1/v2 unchanged.\n` : `\n❌ FAIL (${n} checks)\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
