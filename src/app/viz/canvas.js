import * as d3 from 'd3';
import { edgeColor } from './colors.js';
import { installDefs, drawNode, radiusOf } from './nodes.js';

const LINK_DISTANCE = {
  reportsTo: 90,
  memberOf: 110,
  hasRole: 120,
  assignedApp: 120,
  attribute: 100
};

let svg, viewport, edgeLayer, nodeLayer, simulation, zoomBehavior;
let handlers = {};
let lastNodeCount = 0;
let lastEdgeCount = 0;
let lastClick = { id: null, t: 0 };

const DBLCLICK_MS = 450;
let currentFilters = { edgeKinds: new Set(), nodeTypes: new Set() }; // sets = hidden

export function initCanvas(container, callbacks = {}) {
  handlers = callbacks;

  svg = d3
    .select(container)
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%');

  installDefs(svg);

  viewport = svg.append('g').attr('class', 'viewport');
  edgeLayer = viewport.append('g').attr('class', 'edges');
  nodeLayer = viewport.append('g').attr('class', 'nodes');

  zoomBehavior = d3
    .zoom()
    .scaleExtent([0.15, 4])
    .on('zoom', (event) => viewport.attr('transform', event.transform));

  svg.call(zoomBehavior).on('dblclick.zoom', null);
  svg.on('click', (event) => {
    if (event.target === svg.node()) handlers.onBackgroundClick?.();
  });

  simulation = d3
    .forceSimulation()
    .force('link', d3.forceLink().id((d) => d.id).distance((l) => LINK_DISTANCE[l.kind] ?? 100))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('collide', d3.forceCollide().radius((d) => radiusOf(d, false) + 14))
    .force('x', d3.forceX().strength(0.03))
    .force('y', d3.forceY().strength(0.03))
    .on('tick', tick);
}

function tick() {
  edgeLayer
    .selectAll('line')
    .attr('x1', (d) => d.source.x)
    .attr('y1', (d) => d.source.y)
    .attr('x2', (d) => d.target.x)
    .attr('y2', (d) => d.target.y);
  nodeLayer.selectAll('g.node').attr('transform', (d) => `translate(${d.x},${d.y})`);
}

function dragBehavior() {
  // Heat the simulation only once real movement starts — a bare mousedown
  // (e.g. the first press of a double-click) must not shuffle the graph.
  let heated = false;
  return d3
    .drag()
    .clickDistance(4)
    .on('start', (event, d) => {
      heated = false;
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (event, d) => {
      if (!heated) {
        heated = true;
        if (!event.active) simulation.alphaTarget(0.3).restart();
      }
      d.fx = event.x;
      d.fy = event.y;
    })
    .on('end', (event, d) => {
      if (heated && !event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });
}

export function setFilters(filters) {
  currentFilters = filters;
  applyFilters();
}

function applyFilters() {
  const { edgeKinds, nodeTypes } = currentFilters;
  nodeLayer.selectAll('g.node').classed('dim', (d) => nodeTypes.has(d.type));
  edgeLayer
    .selectAll('line')
    .classed('dim', (d) =>
      edgeKinds.has(d.kind) ||
      nodeTypes.has((d.source.type ?? '')) ||
      nodeTypes.has((d.target.type ?? ''))
    );
}

/** Re-join the store snapshot into the SVG and reheat the simulation. */
export function render(snapshot) {
  const { nodes, edges, focusId } = snapshot;
  const maxHop = nodes.reduce((m, n) => (n.hop !== Infinity && n.hop > m ? n.hop : m), 1);

  edgeLayer
    .selectAll('line')
    .data(edges, (d) => d.id)
    .join('line')
    .attr('class', 'edge')
    .attr('stroke', (d) => edgeColor(d.kind))
    .attr('stroke-width', 1.5);

  nodeLayer
    .selectAll('g.node')
    .data(nodes, (d) => d.id)
    .join(
      (enter) => {
        const g = enter.append('g').attr('class', 'node');
        g.call(dragBehavior());
        // Double-click is detected from two clicks on the same node rather
        // than the native dblclick event — the native event needs both clicks
        // to land on the same pixel-stable element, which host iframes and
        // node drift make unreliable.
        g.on('click', (event, d) => {
          event.stopPropagation();
          handlers.onNodeClick?.(d);
          if (lastClick.id === d.id && event.timeStamp - lastClick.t < DBLCLICK_MS) {
            lastClick = { id: null, t: 0 };
            handlers.onNodeDblClick?.(d);
          } else {
            lastClick = { id: d.id, t: event.timeStamp };
          }
        });
        g.on('dblclick', (event) => event.stopPropagation());
        return g;
      },
      (update) => update,
      (exit) => exit.remove()
    )
    .classed('focus', (d) => d.id === focusId)
    .classed('selected', (d) => d.id === snapshot.selectedId)
    .call(drawNode, { focusId, maxHop });

  // Reheat only on structural change — selection/focus/photo/theme re-renders
  // must leave positions alone or a double-click's first click scatters the
  // graph before the second click lands. Counts suffice: nodes/edges are only
  // ever added (or wiped by clear()), never swapped one-for-one.
  if (nodes.length !== lastNodeCount || edges.length !== lastEdgeCount) {
    lastNodeCount = nodes.length;
    lastEdgeCount = edges.length;
    simulation.nodes(nodes);
    simulation.force('link').links(edges);
    simulation.alpha(0.5).restart();
  }

  applyFilters();
}

/** Smoothly pan/zoom so the given node is centered (context flip). */
export function centerOn(nodeId, snapshot) {
  const node = snapshot.nodes.find((n) => n.id === nodeId);
  if (!node || node.x == null) return;
  const { width, height } = svg.node().getBoundingClientRect();
  const t = d3.zoomIdentity.translate(width / 2 - node.x, height / 2 - node.y);
  svg.transition().duration(600).call(zoomBehavior.transform, t);
}
