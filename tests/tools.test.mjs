// Integration tests: drive the built server over stdio like a real MCP client
// and assert cross-tool consistency invariants (node --test, no test deps).
//
// Live-Graph tests run only when a persisted sign-in exists
// (~/.entrapulse-polyarchy/auth-record.json) — they skip cleanly elsewhere (CI).

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const LIVE = existsSync(join(homedir(), '.entrapulse-polyarchy', 'auth-record.json'));
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Known objects in the dev tenant (idmspecialistdev).
const MIRIAM_UPN = 'miriamg@idmspecialistdev.onmicrosoft.com';
const AMBIGUOUS_NAME = 'Darren Robinson'; // several users share this displayName

let client;

test.before(async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/server/index.js'],
    cwd: join(import.meta.dirname, '..')
  });
  client = new Client({ name: 'tools-consistency-tests', version: '0.0.0' });
  await client.connect(transport);
});

test.after(async () => {
  await client?.close();
});

const call = (name, args = {}) => client.callTool({ name, arguments: args });
const textOf = (res) => res.content?.find((c) => c.type === 'text')?.text ?? '';

/** Every GUID present in structuredContent must also appear in the text block —
 *  not every MCP client surfaces structuredContent to the model. */
function assertTextStructuredParity(res, label) {
  const ids = new Set(JSON.stringify(res.structuredContent ?? {}).match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  ) ?? []);
  const text = textOf(res);
  for (const id of ids) {
    assert.ok(text.includes(id), `${label}: id ${id} is in structuredContent but not in text`);
  }
}

// ---------- schema-level consistency (no Graph, always runs) ----------

test('tools/list exposes the expected tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'get-auth-status', 'get-manager', 'get-photo',
    'polyarchy-expand', 'polyarchy-report', 'polyarchy-search',
    'set-access-token', 'visualize-identity'
  ]);
});

test('person-taking tools all accept userId', async () => {
  const { tools } = await client.listTools();
  for (const name of ['visualize-identity', 'polyarchy-report', 'polyarchy-expand', 'get-photo', 'get-manager']) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool.inputSchema?.properties?.userId, `${name} is missing a userId parameter`);
  }
});

test('search-taking tools describe the disambiguation contract', async () => {
  const { tools } = await client.listTools();
  for (const name of ['visualize-identity', 'polyarchy-report']) {
    const tool = tools.find((t) => t.name === name);
    assert.match(tool.description, /userId/, `${name} description should point at userId re-call`);
  }
});

test('polyarchy-expand without nodeId fails with guidance, not a Graph 404', async () => {
  const res = await call('polyarchy-expand', { nodeType: 'user', dimension: 'org' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /nodeId/);
  assert.doesNotMatch(textOf(res), /undefined/);
});

test('polyarchy-expand attribute without attr/value fails with guidance', async () => {
  const res = await call('polyarchy-expand', { nodeType: 'attribute' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /attr/);
});

// ---------- live Graph consistency (skipped without a persisted sign-in) ----------

test('polyarchy-search returns ids in text and structuredContent', { skip: !LIVE }, async () => {
  const res = await call('polyarchy-search', { term: AMBIGUOUS_NAME });
  assert.notEqual(res.isError, true, textOf(res));
  const { users } = res.structuredContent;
  assert.ok(users.length >= 2, 'expected the ambiguous name to have several matches');
  for (const u of users) assert.match(u.id, GUID);
  assertTextStructuredParity(res, 'polyarchy-search');
});

test('visualize-identity on an ambiguous name returns candidates, does not guess', { skip: !LIVE }, async () => {
  const res = await call('visualize-identity', { search: AMBIGUOUS_NAME });
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(res.structuredContent.ambiguous, true);
  assert.notEqual(res.structuredContent.polyarchy, 'opened');
  assert.ok(res.structuredContent.candidates.length >= 2);
  assertTextStructuredParity(res, 'visualize-identity(ambiguous)');
});

test('visualize-identity exact UPN opens one-shot', { skip: !LIVE }, async () => {
  const res = await call('visualize-identity', { search: MIRIAM_UPN });
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(res.structuredContent.polyarchy, 'opened');
  assert.match(res.structuredContent.focusId, GUID);
});

test('visualize-identity treats a GUID search as an object id', { skip: !LIVE }, async () => {
  const probe = await call('polyarchy-search', { term: MIRIAM_UPN });
  const id = probe.structuredContent.users[0].id;
  const res = await call('visualize-identity', { search: id });
  assert.notEqual(res.isError, true, textOf(res));
  assert.equal(res.structuredContent.polyarchy, 'opened');
  assert.equal(res.structuredContent.focusId, id);
});

test('polyarchy-report covers all dimensions with classified groups', { skip: !LIVE }, async () => {
  const res = await call('polyarchy-report', { search: MIRIAM_UPN });
  assert.notEqual(res.isError, true, textOf(res));
  const r = res.structuredContent;
  assert.match(r.user.id, GUID);
  assert.ok(Array.isArray(r.org.managerChain) && Array.isArray(r.org.directReports));
  assert.ok(Array.isArray(r.groups) && Array.isArray(r.roles) && Array.isArray(r.applications));
  assert.ok('attributes' in r);
  for (const g of r.groups) {
    assert.ok(
      ['Security', 'Microsoft 365', 'Distribution list', 'Mail-enabled security', 'Unknown'].includes(g.type),
      `unexpected group type ${g.type}`
    );
    assert.ok(['assigned', 'dynamic'].includes(g.membership));
    if (g.membership !== 'dynamic') assert.equal(g.membershipRule, undefined);
  }
  assertTextStructuredParity(res, 'polyarchy-report');
});

test('polyarchy-report dimensions filter works', { skip: !LIVE }, async () => {
  const res = await call('polyarchy-report', { search: MIRIAM_UPN, dimensions: ['groups'] });
  assert.notEqual(res.isError, true, textOf(res));
  const r = res.structuredContent;
  assert.ok(Array.isArray(r.groups));
  assert.equal(r.org, undefined);
  assert.equal(r.roles, undefined);
  assert.equal(r.applications, undefined);
});

test('polyarchy-expand accepts UPN and userId alias; edges use canonical GUIDs', { skip: !LIVE }, async () => {
  for (const args of [
    { nodeId: MIRIAM_UPN, nodeType: 'user', dimension: 'groups' },
    { userId: MIRIAM_UPN, nodeType: 'user', dimension: 'groups' }
  ]) {
    const res = await call('polyarchy-expand', args);
    assert.notEqual(res.isError, true, textOf(res));
    const { nodes, edges } = res.structuredContent;
    assert.ok(nodes.length >= 1);
    for (const e of edges) {
      assert.match(e.source, GUID, `edge source ${e.source} is not an object id`);
      assert.match(e.target, GUID, `edge target ${e.target} is not an object id`);
    }
    assertTextStructuredParity(res, `polyarchy-expand(${Object.keys(args)[0]})`);
  }
});

test('polyarchy-expand org returns manager chain and reports as delta', { skip: !LIVE }, async () => {
  const res = await call('polyarchy-expand', { nodeId: MIRIAM_UPN, nodeType: 'user', dimension: 'org' });
  assert.notEqual(res.isError, true, textOf(res));
  const { nodes } = res.structuredContent;
  assert.ok(nodes.length >= 2, 'miriamg should have org relationships');
  assertTextStructuredParity(res, 'polyarchy-expand(org)');
});

test('polyarchy-expand group fan-out chains from a groups expand', { skip: !LIVE }, async () => {
  const groups = await call('polyarchy-expand', { nodeId: MIRIAM_UPN, nodeType: 'user', dimension: 'groups' });
  const groupId = groups.structuredContent.nodes.find((n) => n.type === 'group')?.id;
  assert.ok(groupId, 'expected at least one group to chain into');
  const res = await call('polyarchy-expand', { nodeId: groupId, nodeType: 'group' });
  assert.notEqual(res.isError, true, textOf(res));
  assertTextStructuredParity(res, 'polyarchy-expand(group)');
});

test('get-manager and get-photo answer for a known user', { skip: !LIVE }, async () => {
  const probe = await call('polyarchy-search', { term: MIRIAM_UPN });
  const id = probe.structuredContent.users[0].id;
  const mgr = await call('get-manager', { userId: id });
  assert.notEqual(mgr.isError, true, textOf(mgr));
  assert.ok('manager' in mgr.structuredContent);
  const photo = await call('get-photo', { userId: id });
  assert.ok('dataUri' in photo.structuredContent);
});

test('get-auth-status reports mode and expiry', { skip: !LIVE }, async () => {
  const res = await call('get-auth-status', {});
  assert.notEqual(res.isError, true, textOf(res));
  assert.ok(res.structuredContent.mode);
  assert.equal(typeof res.structuredContent.signedIn, 'boolean');
});
