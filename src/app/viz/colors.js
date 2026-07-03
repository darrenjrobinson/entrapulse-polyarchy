import * as d3 from 'd3';

// Edges — one color per relationship kind (the polyarchy dimensions)
export const edgeColor = d3
  .scaleOrdinal()
  .domain(['reportsTo', 'memberOf', 'hasRole', 'assignedApp', 'attribute'])
  .range(['#4f8ef7', '#34c38f', '#f7b84b', '#e05263', '#9d7bd8']);

export const EDGE_LABELS = {
  reportsTo: 'Reports to',
  memberOf: 'Member of',
  hasRole: 'Has role',
  assignedApp: 'Assigned app',
  attribute: 'Shares attribute'
};

export const NODE_TYPE_LABELS = {
  user: 'Person',
  group: 'Group',
  role: 'Directory role',
  servicePrincipal: 'Application',
  attribute: 'Attribute hub'
};

export const UNREACHABLE = '#4a5568';

export function isLightTheme() {
  return document.documentElement.dataset.theme === 'light';
}

/** Node outline that separates nodes from the canvas in either theme. */
export function nodeStroke() {
  return isLightTheme() ? '#ffffff' : '#0e1117';
}

/**
 * Node fill by degrees of separation from the focal node.
 * The focus gets the highest contrast against the canvas: near-white blue on
 * the dark theme, deep navy on the light theme; each hop steps toward the
 * background. Infinity = unreachable grey.
 */
export function hopColor(hop, maxHop) {
  if (hop === Infinity || hop == null) return UNREACHABLE;
  const span = Math.max(maxHop, 1);
  const t = Math.min(hop / span, 1);
  // interpolateBlues: 0 = near-white, 1 = dark navy
  return d3.interpolateBlues(isLightTheme() ? 0.9 - t * 0.55 : 0.25 + t * 0.55);
}

/** Sample swatches for the legend hop ramp. */
export function hopRamp(steps = 5) {
  return d3.range(steps).map((i) => hopColor(i, steps - 1));
}

// Non-user nodes take the colour of the relationship that connects them, so
// nodes complement their lines. Users keep the blue hop ramp.
const TYPE_EDGE_KIND = {
  group: 'memberOf',
  role: 'hasRole',
  servicePrincipal: 'assignedApp',
  attribute: 'attribute'
};

/** The edge-palette colour for a node type, or null for users. */
export function nodeTypeColor(type) {
  const kind = TYPE_EDGE_KIND[type];
  return kind ? edgeColor(kind) : null;
}

/**
 * Node fill: users shade by hop distance; typed nodes wear their relationship
 * colour, faded toward the canvas with distance so the hop cue survives.
 */
export function nodeFill(d, maxHop) {
  const typeColor = nodeTypeColor(d.type);
  if (!typeColor) return hopColor(d.hop, maxHop);
  if (d.hop === Infinity || d.hop == null) return UNREACHABLE;
  const t = Math.min(d.hop / Math.max(maxHop, 1), 1);
  return d3.interpolateRgb(typeColor, nodeStroke())(t * 0.45);
}
