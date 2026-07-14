/**
 * Shared Backup → Markdown / plain-text rendering core. A pure transform over backup JSON — no DOM,
 * no Notion client, no network, no storage (store-nothing intact). Node + Worker + browser safe.
 *
 * Lifted from web/src/lib/markdown.ts so the CLI's read-only MCP server (cli/src/mcp.ts) and the web
 * "Browse contents" feature can share ONE block-mapping source of truth. The property-value renderer
 * deliberately lives in src/core/backup-query.ts instead (it needs the relation resolver), so this file
 * stays about rich text + blocks + the page title. web/src/lib/markdown.ts imports from here (the old
 * duplicate copies were removed); the landing's vanilla-JS tool remains a manual mirror.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Rich = Array<{
  plain_text?: string;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean };
}>;

/** Recursion guard so a pathologically nested backup can't blow the stack or balloon output. */
const MAX_BLOCK_DEPTH = 12;

const LIST_TYPES = new Set(["bulleted_list_item", "numbered_list_item", "to_do", "toggle"]);

/** Notion rich-text array → inline Markdown (bold/italic/strikethrough/code/link). */
export function richToMd(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return (rich as Rich)
    .map((seg) => {
      let t = seg.plain_text ?? "";
      if (!t) return "";
      const a = seg.annotations ?? {};
      if (a.code) t = "`" + t + "`";
      if (a.bold) t = "**" + t + "**";
      if (a.italic) t = "_" + t + "_";
      if (a.strikethrough) t = "~~" + t + "~~";
      if (seg.href) t = `[${t}](${seg.href})`;
      return t;
    })
    .join("");
}

/** Plain text (no formatting) — for titles, property values, and search. */
export function plainText(rich: unknown): string {
  if (!Array.isArray(rich)) return "";
  return (rich as Rich).map((r) => r.plain_text ?? "").join("");
}

function fileUrl(node: any): string {
  return node?.external?.url ?? node?.file?.url ?? "";
}

/** One block (and its children) → Markdown lines. `indent` is list-nesting depth; `depth` guards recursion. */
export function blockToMd(block: any, indent: number, depth = 0): string[] {
  if (!block || depth > MAX_BLOCK_DEPTH) return [];
  const pad = "  ".repeat(indent);
  const type: string = block?.type ?? "";
  const data = block?.[type] ?? {};
  const text = () => richToMd(data.rich_text);
  const out: string[] = [];

  switch (type) {
    case "heading_1":
      out.push(`# ${text()}`);
      break;
    case "heading_2":
      out.push(`## ${text()}`);
      break;
    case "heading_3":
      out.push(`### ${text()}`);
      break;
    case "paragraph": {
      out.push(text()); // blank paragraphs become blank lines (preserved spacing)
      break;
    }
    case "bulleted_list_item":
      out.push(`${pad}- ${text()}`);
      break;
    case "numbered_list_item":
      out.push(`${pad}1. ${text()}`);
      break;
    case "to_do":
      out.push(`${pad}- [${data.checked ? "x" : " "}] ${text()}`);
      break;
    case "toggle":
      out.push(`${pad}- ${text()}`);
      break;
    case "quote":
      out.push(`> ${text()}`);
      break;
    case "callout":
      out.push(`> ${data.icon?.emoji ? data.icon.emoji + " " : ""}${text()}`);
      break;
    case "code":
      out.push("```" + (data.language && data.language !== "plain text" ? data.language : ""));
      out.push(plainText(data.rich_text));
      out.push("```");
      break;
    case "divider":
      out.push("---");
      break;
    case "equation":
      out.push("$$" + (data.expression ?? "") + "$$");
      break;
    case "bookmark":
    case "embed":
    case "link_preview":
      if (data.url) out.push(data.url);
      break;
    case "image":
    case "file":
    case "pdf":
    case "video":
    case "audio": {
      const url = fileUrl(data) || (data.restora_key ? `(file: ${data.restora_key})` : "");
      const cap = plainText(data.caption) || type;
      out.push(`![${cap}](${url})`);
      break;
    }
    case "child_page":
      out.push(`**${data.title ?? "Untitled page"}** _(sub-page)_`);
      break;
    case "child_database":
      out.push(`**${data.title ?? "Untitled database"}** _(database)_`);
      break;
    case "table": {
      const rows = (block.children ?? []).filter((c: any) => c.type === "table_row");
      rows.forEach((r: any, i: number) => {
        const cells = (r.table_row?.cells ?? []).map((cell: unknown) => richToMd(cell).replace(/\|/g, "\\|"));
        out.push(`| ${cells.join(" | ")} |`);
        if (i === 0) out.push(`| ${cells.map(() => "---").join(" | ")} |`);
      });
      return out; // table_row children already consumed
    }
    default:
      // Unknown/unsupported (column_list, synced_block, ai_block, …) — fall through to its children.
      break;
  }

  // Recurse into children (nested lists, toggle content, columns), except tables (handled above).
  if (Array.isArray(block.children) && type !== "table") {
    const childIndent = LIST_TYPES.has(type) ? indent + 1 : indent;
    for (const child of block.children) out.push(...blockToMd(child, childIndent, depth + 1));
  }
  return out;
}

/** The title property's text for a page (Notion always has exactly one "title" property). */
export function pageTitle(properties: Record<string, any>): string {
  for (const v of Object.values(properties ?? {})) {
    if (v && (v as any).type === "title") return plainText((v as any).title) || "Untitled";
  }
  return "Untitled";
}

/** An array of blocks → one Markdown string (collapsing runs of blank lines). */
export function renderBlocks(blocks: any[]): string {
  const lines: string[] = [];
  for (const b of blocks ?? []) lines.push(...blockToMd(b, 0, 0));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** All readable text from a block subtree — for substring search (titles/props handled separately). */
export function blocksToPlainText(blocks: any[], depth = 0): string {
  if (!Array.isArray(blocks) || depth > MAX_BLOCK_DEPTH) return "";
  const parts: string[] = [];
  for (const b of blocks) {
    const type = b?.type ?? "";
    const data = b?.[type] ?? {};
    if (data.rich_text) parts.push(plainText(data.rich_text));
    if (data.caption) parts.push(plainText(data.caption));
    if (typeof data.title === "string") parts.push(data.title);
    if (Array.isArray(b?.children)) parts.push(blocksToPlainText(b.children, depth + 1));
  }
  return parts.filter(Boolean).join("\n");
}
