// Unit tests for the app's store/model layer (DOM-free ESM, imported directly).
// Focus: restoreExpansion's edgeFilter — pivot-scoped cache restores — and the
// falsy-safe attribute presence predicate (false/0 are real pivot values).

import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/app/store/store.js';
import { userNode, attributeNode, edge, attrValue, hasAttrValue } from '../src/app/store/model.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';

/** A user with two cached attribute-hub edges (department + city pivots). */
function seedUserWithTwoPivots() {
  store.clear();
  const u = store.upsertNode(
    userNode({ id: USER_ID, displayName: 'Miriam', department: 'Sales', city: 'Sydney' })
  );
  const dept = store.upsertNode(attributeNode('department', 'Sales'));
  const city = store.upsertNode(attributeNode('city', 'Sydney'));
  store.upsertEdge(edge(u.id, 'attribute', dept.id));
  store.upsertEdge(edge(u.id, 'attribute', city.id));
  return { u, dept, city };
}

test("restoreExpansion with an edgeFilter restores only that pivot's hub edges", () => {
  const { dept, city } = seedUserWithTwoPivots();
  store.resetCanvas(); // wipes the display, keeps the cache

  const restored = store.restoreExpansion(USER_ID, ['attribute'], (e, src, tgt) =>
    src.startsWith('attr:department:') || tgt.startsWith('attr:department:')
  );

  assert.equal(restored, 1);
  const snap = store.snapshot();
  const ids = new Set(snap.nodes.map((n) => n.id));
  assert.ok(ids.has(dept.id), 'department hub restored');
  assert.ok(!ids.has(city.id), 'city hub must stay off the canvas');
  assert.equal(snap.edges.length, 1);
});

test('restoreExpansion without a filter restores every cached edge of the kind', () => {
  seedUserWithTwoPivots();
  store.resetCanvas();

  const restored = store.restoreExpansion(USER_ID, ['attribute']);

  assert.equal(restored, 2);
  assert.equal(store.snapshot().edges.length, 2);
});

test('restoreExpansion still filters by edge kind', () => {
  const { u } = seedUserWithTwoPivots();
  const mgr = store.upsertNode(
    userNode({ id: '00000000-0000-0000-0000-000000000002', displayName: 'Boss' })
  );
  store.upsertEdge(edge(u.id, 'reportsTo', mgr.id));
  store.resetCanvas();

  const restored = store.restoreExpansion(USER_ID, ['attribute']);

  assert.equal(restored, 2);
  assert.ok(store.snapshot().edges.every((e) => e.kind === 'attribute'));
});

test('edgeFilter sees id strings even after d3 rewrites endpoints to objects', () => {
  const { dept } = seedUserWithTwoPivots();
  // d3-force replaces edge source/target ids with node object references
  for (const e of store.snapshot().edges) {
    e.source = { id: e.source };
    e.target = { id: e.target };
  }
  store.resetCanvas();

  const restored = store.restoreExpansion(USER_ID, ['attribute'], (e, src, tgt) =>
    tgt.startsWith('attr:department:')
  );

  assert.equal(restored, 1);
  assert.ok(store.snapshot().nodes.some((n) => n.id === dept.id));
});

test('hasAttrValue treats false and 0 as present, null/undefined/empty as absent', () => {
  for (const present of [false, 0, 'Sales']) {
    assert.equal(hasAttrValue(present), true, `expected present: ${String(present)}`);
  }
  for (const absent of [undefined, null, '']) {
    assert.equal(hasAttrValue(absent), false, `expected absent: ${String(absent)}`);
  }
  // the disabled-user pivot end-to-end: resolved value is false, still present
  assert.equal(hasAttrValue(attrValue({ accountEnabled: false }, 'accountEnabled')), true);
});
