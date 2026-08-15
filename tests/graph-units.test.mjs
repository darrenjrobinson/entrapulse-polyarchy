// Unit tests for the server Graph layer, driven against the built output like
// the integration suite (pretest runs build:server). gfetch is shadowed
// per-instance so no network or sign-in is involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphClient, hasAttrValue, odataLiteral } from '../build/server/graph.js';

const stubClient = () => new GraphClient({ getGraphToken: async () => 'token' });

test('odataLiteral quotes and escapes string values', () => {
  assert.equal(odataLiteral('department', "O'Brien"), "'O''Brien'");
});

test('odataLiteral emits unquoted lowercase literals for boolean attributes', () => {
  assert.equal(odataLiteral('accountEnabled', 'true'), 'true');
  assert.equal(odataLiteral('accountEnabled', 'False'), 'false');
  assert.equal(odataLiteral('onPremisesSyncEnabled', 'true'), 'true');
});

test('odataLiteral rejects non-boolean values for boolean attributes', () => {
  assert.throws(() => odataLiteral('accountEnabled', 'yes'), /true or false/);
});

test('hasAttrValue treats false and 0 as present, null/undefined/empty as absent', () => {
  for (const present of [false, 0, 'Sales']) {
    assert.equal(hasAttrValue(present), true, `expected present: ${String(present)}`);
  }
  for (const absent of [undefined, null, '']) {
    assert.equal(hasAttrValue(absent), false, `expected absent: ${String(absent)}`);
  }
});

test('getUsersByAttribute builds an unquoted boolean $filter', async () => {
  const client = stubClient();
  const paths = [];
  client.gfetch = async (path) => {
    paths.push(path);
    return { value: [] };
  };

  await client.getUsersByAttribute('accountEnabled', 'true');

  assert.match(paths[0], /\$filter=accountEnabled%20eq%20true&/);
});

test('getUsersByAttribute still quotes and escapes string values', async () => {
  const client = stubClient();
  const paths = [];
  client.gfetch = async (path) => {
    paths.push(path);
    return { value: [] };
  };

  await client.getUsersByAttribute('department', "O'Brien");

  assert.ok(paths[0].includes(encodeURIComponent("department eq 'O''Brien'")));
});

test('expandUserAttribute builds a hub for a false-valued attribute', async () => {
  const client = stubClient();
  client.gfetch = async () => ({ id: 'u1', displayName: 'Miriam', accountEnabled: false });

  const delta = await client.expandUserAttribute('u1', 'accountEnabled');

  assert.equal(delta.nodes.length, 1);
  assert.equal(delta.nodes[0].id, 'attr:accountEnabled:false');
  assert.equal(delta.edges.length, 1);
  assert.doesNotMatch(delta.message, /has no/);
});

test('expandUserAttribute still reports a genuinely absent attribute', async () => {
  const client = stubClient();
  client.gfetch = async () => ({ id: 'u1', displayName: 'Miriam' });

  const delta = await client.expandUserAttribute('u1', 'department');

  assert.deepEqual(delta.nodes, []);
  assert.deepEqual(delta.edges, []);
  assert.match(delta.message, /has no department/);
});
