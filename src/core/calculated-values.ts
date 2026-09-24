/**
 * Calculated values Notion didn't provide — ONE definition for every surface (2026-09-24).
 *
 * Since API 2026-03-11 Notion may answer a formula or rollup with
 *   { "type": "unsupported", "unsupported": {} }      (a rollup keeps its "function")
 * when the result depends on too many related pages or nested formulas — in page values and property
 * items alike, with no partial value. The backup keeps that exactly as Notion sent it; nothing here
 * reconstructs or guesses a calculated result.
 *
 * The metric, `calculatedValuesUnavailable`, is the number of DATABASE PROPERTY CELLS whose calculated
 * result is wholly or partly unavailable. A cell counts exactly once when its formula is unsupported,
 * its rollup is unsupported, or its rollup array holds one or more unsupported members — members are
 * never counted separately. The capture counter (backup.ts), every artifact-derived count and every
 * renderer use the functions below, so no surface decides on its own what "unsupported" means.
 *
 * Pure: no imports, no I/O — shared by the engine, the web bundle, the CLI and the restora-mcp mirror.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** What a human-readable surface (Markdown, Explorer, MCP) shows in place of a calculated value Notion
 *  didn't provide. Tabular exports (CSV, Obsidian) leave the cell EMPTY instead — text there would
 *  contaminate numeric and date columns. */
export const UNAVAILABLE_CALCULATED_TEXT = "(unavailable from Notion)";

/** Rollup arrays don't nest in Notion today; the bound only keeps a malformed file from recursing. */
const MAX_DEPTH = 8;

/** A calculated result — a formula/rollup payload or one rollup array member — that Notion reported as
 *  unavailable: `{ type: "unsupported" }`. */
export function isUnavailableCalculatedResult(x: unknown): boolean {
  return !!x && typeof x === "object" && (x as { type?: unknown }).type === "unsupported";
}

/** A formula/rollup payload (`{ type, [type]: … }`) that is unavailable, or a rollup array holding an
 *  unavailable member. */
function payloadUnavailable(payload: any, depth: number): boolean {
  if (!payload || typeof payload !== "object" || depth > MAX_DEPTH) return false;
  if (isUnavailableCalculatedResult(payload)) return true;
  return payload.type === "array" && Array.isArray(payload.array) && payload.array.some((m: unknown) => memberUnavailable(m, depth + 1));
}

/** One rollup array member: itself unsupported, or a calculated value whose own result is. */
function memberUnavailable(member: any, depth: number): boolean {
  if (!member || typeof member !== "object" || depth > MAX_DEPTH) return false;
  if (isUnavailableCalculatedResult(member)) return true;
  if (member.type === "formula") return payloadUnavailable(member.formula, depth);
  if (member.type === "rollup") return payloadUnavailable(member.rollup, depth);
  return false;
}

/** Whether a property CELL (a raw Notion property value) is a formula or rollup whose calculated result
 *  is wholly or partly unavailable from Notion. Any other property type is never counted. */
export function containsUnavailableCalculatedValue(value: unknown): boolean {
  const v = value as any;
  if (!v || typeof v !== "object") return false;
  if (v.type === "formula") return payloadUnavailable(v.formula, 0);
  if (v.type === "rollup") return payloadUnavailable(v.rollup, 0);
  return false;
}

/** `calculatedValuesUnavailable` measured from a backup artifact: database property cells only (a
 *  standalone page has no formula or rollup properties), each cell at most once. */
export function countCalculatedValuesUnavailable(backup: unknown): number {
  let n = 0;
  for (const db of (backup as { databases?: any[] } | null | undefined)?.databases ?? []) {
    for (const ds of db?.dataSources ?? []) {
      for (const page of ds?.pages ?? []) {
        for (const value of Object.values<unknown>(page?.properties ?? {})) {
          if (containsUnavailableCalculatedValue(value)) n++;
        }
      }
    }
  }
  return n;
}

/** The disclosure for a measured count (> 0): a Coverage NOTE, never a warning. The recalculation
 *  sentence is conditional on purpose — a formula/rollup definition can itself fail to be recreated. */
export function calculatedValuesNote(n: number): string {
  const count = n.toLocaleString(); // same formatting as coverage.ts plural(), so one screen shows one format
  return n === 1
    ? `${count} formula or rollup value was unavailable from Notion when this backup was created. Its property definition is preserved in the backup; Restora does not guess missing calculated values. When a formula or rollup is restored successfully, Notion recalculates its value.`
    : `${count} formula or rollup values were unavailable from Notion when this backup was created. Their property definitions are preserved in the backup; Restora does not guess missing calculated values. When a formula or rollup is restored successfully, Notion recalculates its value.`;
}
