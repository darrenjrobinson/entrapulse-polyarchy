import { edgeColor, EDGE_LABELS, NODE_TYPE_LABELS, hopRamp, hopColor, nodeTypeColor } from './colors.js';
import { setFilters } from './canvas.js';

// checked = visible; hidden kinds/types accumulate into these sets
const hiddenEdgeKinds = new Set();
const hiddenNodeTypes = new Set();

function pushFilters() {
  setFilters({ edgeKinds: hiddenEdgeKinds, nodeTypes: hiddenNodeTypes });
}

function row(container, { swatchColor, round, label, onToggle }) {
  const lab = document.createElement('label');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  cb.addEventListener('change', () => onToggle(!cb.checked));

  const sw = document.createElement('span');
  sw.className = 'swatch' + (round ? ' round' : '');
  sw.style.background = swatchColor;

  lab.append(cb, sw, document.createTextNode(label));
  container.appendChild(lab);
}

/**
 * Build the legend. `presentKinds`/`presentTypes` limit rows to what's
 * actually on screen; call again as new dimensions appear.
 */
export function renderLegend(el, { presentKinds, presentTypes }) {
  el.innerHTML = '';

  const hEdges = document.createElement('h3');
  hEdges.textContent = 'Relationships';
  el.appendChild(hEdges);

  for (const kind of presentKinds) {
    row(el, {
      swatchColor: edgeColor(kind),
      label: EDGE_LABELS[kind] ?? kind,
      onToggle: (hidden) => {
        hidden ? hiddenEdgeKinds.add(kind) : hiddenEdgeKinds.delete(kind);
        pushFilters();
      }
    });
  }

  if (presentTypes.length > 1) {
    const hTypes = document.createElement('h3');
    hTypes.textContent = 'Object types';
    el.appendChild(hTypes);

    for (const type of presentTypes) {
      row(el, {
        // people show the mid-ramp blue; other types wear their edge colour
        swatchColor: nodeTypeColor(type) ?? hopColor(1, 2),
        round: true,
        label: NODE_TYPE_LABELS[type] ?? type,
        onToggle: (hidden) => {
          hidden ? hiddenNodeTypes.add(type) : hiddenNodeTypes.delete(type);
          pushFilters();
        }
      });
    }
  }

  const hHops = document.createElement('h3');
  hHops.textContent = 'Distance from focus';
  el.appendChild(hHops);

  const ramp = document.createElement('div');
  ramp.className = 'hop-ramp';
  const near = document.createElement('span');
  near.className = 'lbl';
  near.textContent = 'focus';
  ramp.appendChild(near);
  for (const c of hopRamp(5)) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = c;
    ramp.appendChild(chip);
  }
  const far = document.createElement('span');
  far.className = 'lbl';
  far.textContent = 'far';
  ramp.appendChild(far);
  el.appendChild(ramp);
}
