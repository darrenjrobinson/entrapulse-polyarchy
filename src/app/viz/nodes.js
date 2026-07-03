import * as d3 from 'd3';
import { nodeFill, nodeStroke, UNREACHABLE, isLightTheme } from './colors.js';
import { initials } from '../store/model.js';

// Fluent-style icon paths, 24x24 viewBox, one <symbol> per node type.
const ICONS = {
  user: 'M12 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM12 13c4.42 0 8 2.24 8 5v1.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V18c0-2.76 3.58-5 8-5Z',
  group: 'M8.5 4a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm7 1a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM8.5 12.5c3.31 0 6 1.79 6 4v1.75a.75.75 0 0 1-.75.75h-10.5a.75.75 0 0 1-.75-.75V16.5c0-2.21 2.69-4 6-4Zm7 .5c2.49 0 4.5 1.5 4.5 3.35v1.4a.75.75 0 0 1-.75.75H15.9c.06-.24.1-.49.1-.75V16.5c0-1.25-.5-2.37-1.32-3.27.26-.15.53-.23.82-.23Z',
  role: 'M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5l8-3Zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM12 13c-2.5 0-4.5 1.2-4.5 2.7v.8c1.2 1.6 2.8 2.8 4.5 3.4 1.7-.6 3.3-1.8 4.5-3.4v-.8c0-1.5-2-2.7-4.5-2.7Z',
  servicePrincipal: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
  attribute: 'M11.2 3a2 2 0 0 0-1.42.59L3.6 9.77a2 2 0 0 0 0 2.83l7.8 7.8a2 2 0 0 0 2.83 0l6.18-6.18A2 2 0 0 0 21 12.8V5a2 2 0 0 0-2-2h-7.8ZM16.5 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z'
};

export const NODE_RADIUS = { user: 16, group: 18, role: 17, servicePrincipal: 17, attribute: 19 };

export function radiusOf(node, isFocus) {
  return (NODE_RADIUS[node.type] ?? 16) * (isFocus ? 1.45 : 1);
}

/** Install per-type <symbol> icons and the shared avatar clipPath. */
export function installDefs(svg) {
  const defs = svg.append('defs');
  for (const [type, path] of Object.entries(ICONS)) {
    defs
      .append('symbol')
      .attr('id', `icon-${type}`)
      .attr('viewBox', '0 0 24 24')
      .append('path')
      .attr('d', path);
  }
  defs
    .append('clipPath')
    .attr('id', 'avatar-clip')
    .attr('clipPathUnits', 'objectBoundingBox')
    .append('circle')
    .attr('cx', 0.5)
    .attr('cy', 0.5)
    .attr('r', 0.5);
}

function iconContrast(fill) {
  if (fill === UNREACHABLE) return '#dce3ee';
  return d3.hcl(fill).l > 60 ? '#132036' : isLightTheme() ? '#f2f6fc' : '#dce3ee';
}

/**
 * Render/update node visuals inside each node <g>. Called on every store
 * change; rebuilds the glyph so hop recolors and photo arrivals apply.
 */
export function drawNode(selection, { focusId, maxHop }) {
  selection.each(function (d) {
    const g = d3.select(this);
    const isFocus = d.id === focusId;
    const r = radiusOf(d, isFocus);
    const fill = nodeFill(d, maxHop);

    g.selectAll('*').remove();

    // focus ring
    if (isFocus) {
      g.append('circle')
        .attr('class', 'focus-ring')
        .attr('r', r + 5)
        .attr('fill', 'none')
        .attr('stroke', '#4f8ef7')
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '3 3');
    }

    g.append('circle')
      .attr('r', r)
      .attr('fill', fill)
      .attr('stroke', d.id === focusId ? '#4f8ef7' : nodeStroke())
      .attr('stroke-width', 1.5);

    if (d.type === 'user' && d.photoUrl) {
      g.append('image')
        .attr('href', d.photoUrl)
        .attr('x', -r)
        .attr('y', -r)
        .attr('width', r * 2)
        .attr('height', r * 2)
        .attr('clip-path', 'url(#avatar-clip)')
        .attr('preserveAspectRatio', 'xMidYMid slice');
    } else if (d.type === 'user' && d.hop <= 1 && d.hop !== Infinity) {
      // near nodes without photos get initials; farther ones get the icon
      g.append('text')
        .attr('class', 'node-initials')
        .attr('text-anchor', 'middle')
        .attr('dy', '0.35em')
        .attr('fill', iconContrast(fill))
        .attr('font-size', r * 0.75)
        .attr('font-weight', 600)
        .text(initials(d.label));
    } else {
      const s = r * 1.15;
      g.append('use')
        .attr('href', `#icon-${d.type}`)
        .attr('x', -s / 2)
        .attr('y', -s / 2)
        .attr('width', s)
        .attr('height', s)
        .attr('fill', iconContrast(fill));
    }

    g.append('text')
      .attr('class', 'node-label')
      .attr('text-anchor', 'middle')
      .attr('y', r + 13)
      .text(d.label.length > 24 ? d.label.slice(0, 23) + '…' : d.label);
  });
}
