/**
 * Pure workspace-tree assembly for the "Select what to protect" explorer. Takes the flat node list
 * from discovery (databases + standalone pages, each with a parent id) and nests them GitHub-style.
 * Pure (no I/O), so it's unit-tested directly (scripts/tree-assembly-test.ts) and shared by the web.
 */
export interface WorkspaceItem {
  id: string;
  kind: "database" | "page";
  title: string;
  parentId?: string;
  parentType?: string;
  dataSourceCount?: number;
}

export interface TreeNode {
  item: WorkspaceItem;
  children: TreeNode[];
  depth: number;
}

/** True if walking up `item`'s parent chain revisits a node — a corrupt/looping backup. */
function inCycle(item: WorkspaceItem, byId: Map<string, TreeNode>): boolean {
  const seen = new Set<string>();
  let cur: WorkspaceItem | undefined = item;
  while (cur) {
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId)?.item : undefined;
  }
  return false;
}

/**
 * Assemble a forest from flat items. A node nests under its parent only when that parent is also in
 * the set and the chain is acyclic; otherwise it's a root (parent outside the selection, a workspace/
 * data-source parent, or a cycle — all safely flattened to the top level). Input order is preserved.
 */
export function assembleTree(items: WorkspaceItem[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const item of items) byId.set(item.id, { item, children: [], depth: 0 });
  const roots: TreeNode[] = [];
  for (const item of items) {
    const node = byId.get(item.id)!;
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    if (parent && parent !== node && !inCycle(item, byId)) parent.children.push(node);
    else roots.push(node);
  }
  const setDepth = (node: TreeNode, depth: number): void => {
    node.depth = depth;
    for (const c of node.children) setDepth(c, depth + 1);
  };
  for (const r of roots) setDepth(r, 0);
  return roots;
}

/** Keep nodes whose title matches `query`, or any descendant does — preserving the branch shape. */
export function filterTree(roots: TreeNode[], query: string): TreeNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return roots;
  const keep = (node: TreeNode): TreeNode | null => {
    const kids = node.children.map(keep).filter((n): n is TreeNode => n !== null);
    if (node.item.title.toLowerCase().includes(needle) || kids.length > 0) {
      return { ...node, children: kids };
    }
    return null;
  };
  return roots.map(keep).filter((n): n is TreeNode => n !== null);
}

/** Map each node id → its ancestor titles (root-first, excluding the node itself). Used to show a
 *  "Home › Projects" breadcrumb on search results so identically-named pages are distinguishable. */
export function buildPathMap(roots: TreeNode[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const walk = (node: TreeNode, ancestors: string[]): void => {
    map.set(node.item.id, ancestors);
    const next = [...ancestors, node.item.title];
    for (const c of node.children) walk(c, next);
  };
  for (const r of roots) walk(r, []);
  return map;
}

/** Every id under a node (inclusive), split by kind — used to select/deselect a whole subtree. */
export function subtreeIds(node: TreeNode): { databases: string[]; pages: string[] } {
  const databases: string[] = [];
  const pages: string[] = [];
  const walk = (n: TreeNode): void => {
    if (n.item.kind === "database") databases.push(n.item.id);
    else pages.push(n.item.id);
    n.children.forEach(walk);
  };
  walk(node);
  return { databases, pages };
}
