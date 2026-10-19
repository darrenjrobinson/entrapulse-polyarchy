// Unit tests for the server Graph layer, driven against the built output like
// the integration suite (pretest runs build:server). gfetch is shadowed
// per-instance so no network or sign-in is involved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphClient, hasAttrValue, isAllowedLogoUrl, odataLiteral, sniffImageType } from '../build/server/graph.js';

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

// ---------- node images: group photos + application logos ----------

const SP = '00000000-0000-0000-0000-000000000001';
const CDN = 'https://secure.aadcdn.microsoftonline-p.com/abc/appbranding/xyz/1.0/LogoImage';
// a PNG signature + filler: the logo path sniffs types from the bytes
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_URI = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;

/** Swap globalThis.fetch (the CDN leg) for the duration of fn. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test('getPhotoDataUri reads a group photo from /groups when asked', async () => {
  const client = stubClient();
  const paths = [];
  client.gfetch = async (path) => {
    paths.push(path);
    return new Response(new Uint8Array([7]), { headers: { 'Content-Type': 'image/jpeg' } });
  };

  assert.equal(await client.getPhotoDataUri('g1', 'groups'), 'data:image/jpeg;base64,Bw==');
  await client.getPhotoDataUri('u1');
  assert.deepEqual(paths, ['/groups/g1/photos/48x48/$value', '/users/u1/photos/48x48/$value']);
});

test('getAppLogoDataUri inlines the CDN logo, fetched without the Graph token', async () => {
  const client = stubClient();
  client.gfetch = async (path) => {
    assert.equal(path, `/servicePrincipals/${SP}?$select=id,info,applicationTemplateId`);
    return { id: SP, info: { logoUrl: CDN } };
  };

  await withFetch(
    // the gallery CDN labels its PNGs application/octet-stream — the type comes from the bytes
    async () => new Response(PNG, { headers: { 'Content-Type': 'application/octet-stream' } }),
    async (calls) => {
      assert.equal(await client.getAppLogoDataUri(SP), PNG_URI);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, CDN);
      assert.equal(calls[0].init?.headers, undefined);
      assert.ok(calls[0].init?.signal instanceof AbortSignal);
    }
  );
});

test('getAppLogoUrl prefers the tenant branding logo, else the gallery template logo', async () => {
  const client = stubClient();
  const GALLERY = 'https://galleryapplogos1.azureedge.net/app-logo/slack_BA2EAFA8_215.png';
  const paths = [];
  const route = (sp) => async (path) => {
    paths.push(path);
    return path.startsWith('/applicationTemplates/') ? { id: 'tpl1', logoUrl: GALLERY } : sp;
  };

  client.gfetch = route({ id: SP, info: { logoUrl: CDN }, applicationTemplateId: 'tpl1' });
  assert.equal(await client.getAppLogoUrl(SP), CDN);
  assert.equal(paths.length, 1, 'a branding logo needs no template lookup');

  paths.length = 0;
  client.gfetch = route({ id: SP, info: { logoUrl: null }, applicationTemplateId: 'tpl1' });
  assert.equal(await client.getAppLogoUrl(SP), GALLERY);
  assert.deepEqual(paths, [
    `/servicePrincipals/${SP}?$select=id,info,applicationTemplateId`,
    '/applicationTemplates/tpl1?$select=id,logoUrl'
  ]);

  client.gfetch = route({ id: SP, info: {}, applicationTemplateId: null });
  assert.equal(await client.getAppLogoUrl(SP), null, 'first-party apps have neither');
});

test('getAppLogoDataUri is null for no logo, an off-allowlist host, or a non-image', async () => {
  const client = stubClient();
  const realError = console.error;
  console.error = () => {};
  try {
    await withFetch(
      async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
      async (calls) => {
        client.gfetch = async () => ({ id: SP, info: { logoUrl: null } });
        assert.equal(await client.getAppLogoDataUri(SP), null);

        client.gfetch = async () => ({ id: SP, info: { logoUrl: 'https://169.254.169.254/metadata' } });
        assert.equal(await client.getAppLogoDataUri(SP), null);
        assert.equal(calls.length, 0, 'an off-allowlist host is never fetched');

        client.gfetch = async () => ({ id: SP, info: { logoUrl: CDN } });
        assert.equal(await client.getAppLogoDataUri(SP), null);

        client.gfetch = async () => {
          throw Object.assign(new Error('Graph returned 403'), { status: 403 });
        };
        assert.equal(await client.getAppLogoDataUri(SP), null);
      }
    );
  } finally {
    console.error = realError;
  }
});

test('sniffImageType recognises raster images only (no SVG — it can carry script)', () => {
  const b = (...x) => new Uint8Array(x);
  assert.equal(sniffImageType(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(sniffImageType(b(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffImageType(b(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'image/gif');
  assert.equal(sniffImageType(b(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)), 'image/webp');
  assert.equal(sniffImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(sniffImageType(new TextEncoder().encode('<html>')), null);
  assert.equal(sniffImageType(b()), null);
});

test('isAllowedLogoUrl holds logo fetches to https Entra CDN hosts', () => {
  for (const [url, ok] of [
    [CDN, true],
    ['https://aadcdn.msftauthimages.net/x/logo.png', true],
    ['https://galleryapplogos1.azureedge.net/app-logo/slack_BA2EAFA8_215.png', true],
    ['https://evil.azureedge.net/app-logo/x.png', false],
    ['https://x.galleryapplogos1.azureedge.net/app-logo/x.png', false],
    ['http://secure.aadcdn.microsoftonline-p.com/x', false],
    ['https://aadcdn.msftauth.net.evil.example/x', false],
    ['https://evilaadcdn.msauth.net/x', false],
    ['not a url', false]
  ]) {
    assert.equal(isAllowedLogoUrl(url), ok, url);
  }
});
