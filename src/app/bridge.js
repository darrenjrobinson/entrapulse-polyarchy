// Replaces the SPA's direct-Graph layer: every data need becomes a
// tools/call to the entrapulse-polyarchy server via the MCP Apps host bridge.

let app = null;
let toolCalls = 0;
const countListeners = new Set();
const photoCache = new Map(); // userId -> Promise<string|null>

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

/** data: URI or null; memoized per user. */
export function getPhotoDataUri(userId) {
  if (photoCache.has(userId)) return photoCache.get(userId);
  const p = call('get-photo', { userId })
    .then(({ dataUri }) => dataUri ?? null)
    .catch(() => null);
  photoCache.set(userId, p);
  return p;
}
