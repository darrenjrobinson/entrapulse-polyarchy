import './styles.css';
import { App } from '@modelcontextprotocol/ext-apps';
import * as bridge from './bridge.js';
import * as store from './store/store.js';
import { attributeNode, attrValue, edge } from './store/model.js';
import { initCanvas, render, centerOn } from './viz/canvas.js';
import { renderLegend } from './viz/legend.js';
import { initPanel, showPanel, hidePanel } from './ui/panel.js';
import { initSearch } from './ui/search.js';
import { initToolbar, getView, getPivotAttr } from './ui/toolbar.js';

const $ = (id) => document.getElementById(id);

// ---------- status bar ----------

function setStatus(msg, isError = false) {
  const el = $('stat-msg');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

bridge.onToolCall((n) => ($('stat-api').textContent = `${n} tool calls`));

// ---------- graph merging ----------

let photoNotifyTimer = null;

function loadPhoto(node) {
  if (node.type !== 'user' || node.photoUrl !== null || node.photoTried) return;
  node.photoTried = true;
  bridge.getPhotoDataUri(node.id).then((uri) => {
    if (!uri) return;
    node.photoUrl = uri;
    clearTimeout(photoNotifyTimer);
    photoNotifyTimer = setTimeout(() => store.notify(), 250);
  });
}

/** Fold a server {nodes, edges} delta into the store. */
function mergeDelta(delta) {
  for (const n of delta.nodes ?? []) {
    const node = store.upsertNode({ hop: Infinity, expanded: false, photoUrl: null, ...n });
    loadPhoto(node);
  }
  for (const e of delta.edges ?? []) store.upsertEdge(e);
}

// ---------- model context ----------

function tellModel() {
  try {
    const snap = store.snapshot();
    const focus = snap.nodes.find((n) => n.id === snap.focusId);
    app.updateModelContext({
      structuredContent: {
        view: getView(),
        focus: focus ? { id: focus.id, type: focus.type, label: focus.label } : null,
        nodes: snap.nodes.length,
        edges: snap.edges.length
      }
    });
  } catch {
    // model-context updates are best-effort; never break the UI over them
  }
}

// ---------- expansion (all dimensions go through the server) ----------

/** Edge kinds a node's expansion produces — used to restore from cache. */
function expansionKinds(node, view) {
  if (node.type === 'group') return ['memberOf'];
  if (node.type === 'role') return ['hasRole'];
  if (node.type === 'attribute') return ['attribute'];
  return {
    org: ['reportsTo'],
    groups: ['memberOf'],
    access: ['hasRole', 'assignedApp'],
    attributes: ['attribute']
  }[view] ?? ['reportsTo'];
}

async function expandNode(node) {
  const view = getView();
  if (node.expandedIn?.has(view)) {
    // fetched earlier this session — rebuild from cache, no server round-trip
    const restored = store.restoreExpansion(node.id, expansionKinds(node, view));
    store.computeHops(store.getFocusId());
    store.notify();
    if (restored) setStatus(`${node.label}: ${restored} relationship(s) from cache`);
    tellModel();
    return;
  }
  setStatus(`Expanding ${node.label}…`);
  try {
    let args;
    if (node.type === 'attribute') {
      args = { nodeType: 'attribute', attr: node.data.attr, value: String(node.data.value) };
    } else if (node.type === 'group' || node.type === 'role') {
      args = { nodeId: node.id, nodeType: node.type };
    } else if (node.type === 'user') {
      args = { nodeId: node.id, nodeType: 'user', dimension: view };
      if (view === 'attributes') args.attr = getPivotAttr();
    } else {
      setStatus('Applications have nothing to expand yet');
      return;
    }
    const delta = await bridge.expand(args);
    mergeDelta(delta);
    node.expanded = true;
    (node.expandedIn ??= new Set()).add(view);
    store.computeHops(store.getFocusId());
    store.notify();
    setStatus(delta.message ?? 'Expanded');
    tellModel();
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  }
}

/** Context flip: new focus, recompute hops, recolor, glide to center. */
function flipContext(node) {
  store.setFocus(node.id);
  centerOn(node.id, store.snapshot());
  expandNode(node); // served from cache when already fetched in this view
}

/** Pivot every known user onto the selected attribute's hub nodes (local-only). */
function buildAttributeHubs() {
  const attr = getPivotAttr();
  let hubs = 0;
  for (const n of store.snapshot().nodes) {
    const value = n.type === 'user' ? attrValue(n.data, attr) : undefined;
    if (!value) continue;
    const hub = store.upsertNode({
      hop: Infinity, expanded: false, ...attributeNode(attr, value)
    });
    store.upsertEdge(edge(n.id, 'attribute', hub.id));
    hubs++;
  }
  store.computeHops(store.getFocusId());
  store.notify();
  return hubs;
}

function resolveManager(node) {
  if (node.managerTried) return;
  node.managerTried = true;
  queueMicrotask(async () => {
    try {
      const known = store.managerOf(node.id);
      node.managerInfo = known ? known.data : (await bridge.getManager(node.id)) ?? false;
      store.notify();
    } catch (err) {
      console.error(err);
      node.managerTried = false;
    }
  });
}

async function loadUserAndFocus(u) {
  $('welcome').hidden = true;
  const node = store.upsertNode({
    hop: Infinity, expanded: false, photoUrl: null,
    id: u.id, type: 'user', label: u.displayName ?? u.userPrincipalName ?? u.id, data: u
  });
  loadPhoto(node);
  store.notify();
  flipContext(node);
}

function resetCanvas() {
  store.resetCanvas();
  hidePanel();
  $('welcome-msg').textContent =
    'Canvas cleared. Search for a person above, or ask the host to open a new polyarchy — ' +
    'anything already explored reloads instantly from cache.';
  $('welcome').hidden = false;
  setStatus('Canvas cleared (cache kept)');
  tellModel();
}

// ---------- UI wiring ----------

function onStoreChange(snapshot) {
  render(snapshot);
  $('stat-nodes').textContent = `${snapshot.nodes.length} nodes`;
  $('stat-edges').textContent = `${snapshot.edges.length} edges`;

  const presentKinds = [...new Set(snapshot.edges.map((e) => e.kind))];
  const presentTypes = [...new Set(snapshot.nodes.map((n) => n.type))];
  renderLegend($('legend'), { presentKinds, presentTypes });

  const sel = snapshot.nodes.find((n) => n.id === snapshot.selectedId);
  if (sel && !$('panel').hidden) {
    showPanel(sel, { isFocus: sel.id === snapshot.focusId });
  }
}

function onViewChange(view) {
  if (view === 'attributes') {
    const hubs = buildAttributeHubs();
    setStatus(hubs ? `Pivoted on ${getPivotAttr()}` : `No ${getPivotAttr()} values loaded yet`);
  }
  const focus = store.getNode(store.getFocusId());
  if (focus?.type === 'user' && !focus.expandedIn?.has(view)) expandNode(focus);
}

function initUi() {
  initCanvas($('canvas'), {
    onNodeClick: (node) => {
      store.setSelected(node.id);
      showPanel(node, { isFocus: node.id === store.getFocusId() });
    },
    onNodeDblClick: (node) => flipContext(node),
    onBackgroundClick: () => {
      store.setSelected(null);
      hidePanel();
    }
  });

  initPanel({
    onFocus: (node) => flipContext(node),
    onExpand: (node) => expandNode(node),
    onClose: () => store.setSelected(null),
    onNeedManager: (node) => resolveManager(node),
    onPickManager: (mgr) => loadUserAndFocus(mgr)
  });

  initToolbar({
    onViewChange,
    onAttrChange: () => {
      const hubs = buildAttributeHubs();
      setStatus(hubs ? `Pivoted on ${getPivotAttr()}` : `No ${getPivotAttr()} values loaded yet`);
    },
    onReset: resetCanvas
  });
  initSearch((user) => loadUserAndFocus(user));
  store.subscribe(onStoreChange);
}

// ---------- host theme ----------

function applyHostTheme(ctx) {
  const theme = ctx?.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  if (store.snapshot().nodes.length) store.notify(); // re-render SVG colors
}

// ---------- MCP App bootstrap ----------

const app = new App({ name: 'entrapulse-polyarchy-app', version: '0.1.8' });
bridge.setApp(app);

app.ontoolresult = (params) => {
  const sc = params?.structuredContent;
  if (!sc) return;
  if (sc.polyarchy === 'opened' && sc.focusId) {
    $('welcome').hidden = true;
    mergeDelta(sc);
    const focusNode = store.getNode(sc.focusId);
    if (focusNode) {
      focusNode.expanded = true;
      (focusNode.expandedIn ??= new Set()).add('org');
    }
    store.setFocus(sc.focusId);
    setStatus(sc.message ?? 'Loaded');
    // let the force layout place nodes before gliding to the focus
    setTimeout(() => centerOn(sc.focusId, store.snapshot()), 400);
    tellModel();
  } else if (sc.nodes) {
    // model-driven expansion delivered to the app
    mergeDelta(sc);
    store.computeHops(store.getFocusId());
    store.notify();
  }
};

app.onhostcontextchanged = (params) => applyHostTheme(params?.hostContext ?? params);

initUi();

app
  .connect()
  .then(() => {
    try {
      applyHostTheme(app.getHostContext?.());
    } catch { /* host context optional */ }
  })
  .catch((err) => {
    console.error(err);
    $('welcome-msg').textContent =
      'Could not connect to the MCP host. This app must run inside an MCP Apps-capable client.';
  });
