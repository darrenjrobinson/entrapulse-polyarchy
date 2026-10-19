// Replaces the SPA's direct-Graph layer: every data need becomes a
// tools/call to the entrapulse-polyarchy server via the MCP Apps host bridge.

let app = null;
let toolCalls = 0;
const countListeners = new Set();
const photoCache = new Map(); // `${kind}:${id}` -> Promise<string|null>

export function setApp(a) {
  app = a;
}

export function onToolCall(fn) {
  countListeners.add(fn);
}

async function call(name, args) {
  toolCalls++;
  countListeners.forEach((fn) => fn(toolCalls));
  const result = await app.callServerTool({
    name,
    arguments: args,
    _meta: { 'polyarchy/origin': 'app' }
  });
  if (result.isError) {
    throw new Error(result.content?.find((c) => c.type === 'text')?.text ?? `${name} failed`);
  }
  return result.structuredContent ?? {};
}

/** One call per double-click/Expand — returns a {nodes, edges, message} delta. */
export function expand(args) {
  return call('polyarchy-expand', args);
}

export async function searchUsers(term) {
  const { users } = await call('polyarchy-search', { term });
  return users ?? [];
}

export async function getManager(userId) {
  const { manager } = await call('get-manager', { userId });
  return manager ?? null;
}

/**
 * Node image as a data: URI or null; memoized per kind + id. Users and
 * Microsoft 365 groups get their photo, applications their logo.
 */
export function getAvatarDataUri(kind, id) {
  const key = `${kind}:${id}`;
  if (photoCache.has(key)) return photoCache.get(key);
  const p = (kind === 'servicePrincipal'
    ? call('get-app-logo', { servicePrincipalId: id })
    : call('get-photo', { userId: id, kind }))
    .then(({ dataUri }) => dataUri ?? null)
    .catch(() => null);
  photoCache.set(key, p);
  return p;
}
