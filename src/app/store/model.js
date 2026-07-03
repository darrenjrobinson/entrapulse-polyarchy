// Node/edge factories. Edge kinds are the polyarchy's relationship dimensions.

export const EDGE_KINDS = ['reportsTo', 'memberOf', 'hasRole', 'assignedApp', 'attribute'];

export const NODE_TYPES = ['user', 'group', 'role', 'servicePrincipal', 'attribute'];

export function userNode(u) {
  return {
    id: u.id,
    type: 'user',
    label: u.displayName ?? u.userPrincipalName ?? u.id,
    data: u,
    hop: Infinity,
    expanded: false,
    photoUrl: null
  };
}

export function groupNode(g) {
  return {
    id: g.id,
    type: 'group',
    label: g.displayName ?? g.id,
    data: g,
    hop: Infinity,
    expanded: false
  };
}

export function roleNode(r) {
  return {
    id: r.id,
    type: 'role',
    label: r.displayName ?? r.id,
    data: r,
    hop: Infinity,
    expanded: false
  };
}

export function servicePrincipalNode(sp) {
  return {
    id: sp.id,
    type: 'servicePrincipal',
    label: sp.displayName ?? sp.id,
    data: sp,
    hop: Infinity,
    expanded: false
  };
}

/**
 * Attribute pivots are virtual hub nodes (no directory object behind them),
 * e.g. attributeNode('department', 'Sales') -> id 'attr:department:Sales'.
 * Clicking one loads its cohort and flips context to it.
 */
export function attributeNode(attr, value) {
  return {
    id: `attr:${attr}:${value}`,
    type: 'attribute',
    label: String(value),
    data: { attr, value, description: `Everyone sharing ${attr} = “${value}”` },
    hop: Infinity,
    expanded: false
  };
}

/** Resolve a possibly nested attribute path, e.g. 'onPremisesExtensionAttributes/extensionAttribute9'. */
export function attrValue(data, attr) {
  return attr.split('/').reduce((obj, key) => obj?.[key], data);
}

export function edge(sourceId, kind, targetId) {
  return {
    id: `${sourceId}|${kind}|${targetId}`,
    source: sourceId,
    target: targetId,
    kind
  };
}

export function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';
}
