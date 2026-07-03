// In-memory graph store in two layers:
//  - cache:   every node/edge ever fetched this session — survives canvas
//    resets so repeat explorations never re-hit Microsoft Graph
//  - display: what's currently on the canvas (nodes/edges/adjacency, pub/sub,
//    BFS hop distances)

const nodeCache = new Map(); // id -> node (superset, owns the objects)
const edgeCache = new Map(); // id -> edge (superset)
const cacheIncident = new Map(); // nodeId -> Set<edgeId> (for cache restore)

const nodes = new Map(); // id -> node (displayed)
const edges = new Map(); // id -> edge (displayed)
const adjacency = new Map(); // id -> Set<neighborId> (displayed)

let focusId = null;
let selectedId = null;
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  const snap = snapshot();
  listeners.forEach((fn) => fn(snap));
}

export function snapshot() {
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    focusId,
    selectedId
  };
}

export function getNode(id) {
  return nodes.get(id) ?? nodeCache.get(id);
}

/** d3 rewrites edge source/target into node objects — always resolve to ids. */
function endpointsOf(e) {
  return [
    typeof e.source === 'object' ? e.source.id : e.source,
    typeof e.target === 'object' ? e.target.id : e.target
  ];
}

function displayNode(n) {
  if (nodes.has(n.id)) return;
  nodes.set(n.id, n);
  if (!adjacency.has(n.id)) adjacency.set(n.id, new Set());
}

function displayEdge(e) {
  if (edges.has(e.id)) return;
  edges.set(e.id, e);
  const [src, tgt] = endpointsOf(e);
  (adjacency.get(src) ?? adjacency.set(src, new Set()).get(src)).add(tgt);
  (adjacency.get(tgt) ?? adjacency.set(tgt, new Set()).get(tgt)).add(src);
}

export function upsertNode(node) {
  let n = nodeCache.get(node.id);
  if (n) {
    // keep runtime state (position, hop, expanded, photo) — refresh data/label
    n.data = node.data;
    n.label = node.label;
  } else {
    n = node;
    nodeCache.set(n.id, n);
  }
  displayNode(n);
  return n;
}

export function upsertEdge(e) {
  let ed = edgeCache.get(e.id);
  if (!ed) {
    ed = e;
    edgeCache.set(ed.id, ed);
    const [src, tgt] = endpointsOf(ed);
    (cacheIncident.get(src) ?? cacheIncident.set(src, new Set()).get(src)).add(ed.id);
    (cacheIncident.get(tgt) ?? cacheIncident.set(tgt, new Set()).get(tgt)).add(ed.id);
  }
  displayEdge(ed);
  return ed;
}

/** Wipe the canvas but keep the fetched-data cache. */
export function resetCanvas() {
  nodes.clear();
  edges.clear();
  adjacency.clear();
  focusId = null;
  selectedId = null;
  notify();
}

/**
 * Re-display a node's cached relationships of the given edge kinds without a
 * server call. Returns how many edges were brought back onto the canvas.
 */
export function restoreExpansion(nodeId, kinds) {
  const node = nodeCache.get(nodeId);
  if (!node) return 0;
  displayNode(node);
  let restored = 0;
  for (const edgeId of cacheIncident.get(nodeId) ?? []) {
    const e = edgeCache.get(edgeId);
    if (!kinds.includes(e.kind)) continue;
    if (edges.has(e.id)) continue;
    const [src, tgt] = endpointsOf(e);
    displayNode(nodeCache.get(src));
    displayNode(nodeCache.get(tgt));
    displayEdge(e);
    restored++;
  }
  return restored;
}

/**
 * The user's manager if already fetched (reportsTo edges run user -> manager).
 * Consults the cache so a canvas reset doesn't force a new Graph call.
 * Matches on edge id strings — d3 rewrites edge source/target into node
 * objects, so those can't be compared to ids.
 */
export function managerOf(userId) {
  const prefix = `${userId}|reportsTo|`;
  for (const id of edgeCache.keys()) {
    if (id.startsWith(prefix)) return nodeCache.get(id.slice(prefix.length)) ?? null;
  }
  return null;
}

export function neighbors(id) {
  return [...(adjacency.get(id) ?? [])].map((nid) => nodes.get(nid)).filter(Boolean);
}

/** Undirected BFS from the focus node; unreachable nodes get Infinity. */
export function computeHops(fromId) {
  for (const n of nodes.values()) n.hop = Infinity;
  const start = nodes.get(fromId);
  if (!start) return;
  start.hop = 0;
  const queue = [fromId];
  while (queue.length) {
    const id = queue.shift();
    const hop = nodes.get(id).hop;
    for (const nid of adjacency.get(id) ?? []) {
      const n = nodes.get(nid);
      if (n && n.hop === Infinity) {
        n.hop = hop + 1;
        queue.push(nid);
      }
    }
  }
}

/** The PolyArchy context flip: re-anchor hop distances on a new node. */
export function setFocus(id) {
  focusId = id;
  computeHops(id);
  notify();
}

export function getFocusId() {
  return focusId;
}

export function setSelected(id) {
  selectedId = id;
  notify();
}

export function getSelectedId() {
  return selectedId;
}

export function maxHop() {
  let max = 0;
  for (const n of nodes.values()) {
    if (n.hop !== Infinity && n.hop > max) max = n.hop;
  }
  return max;
}

export function clear() {
  nodeCache.clear();
  edgeCache.clear();
  cacheIncident.clear();
  nodes.clear();
  edges.clear();
  adjacency.clear();
  focusId = null;
  selectedId = null;
  notify();
}
