import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { AuthManager } from './auth.js';
import { GraphClient, reportGroup, type Delta } from './graph.js';

export const RESOURCE_URI = 'ui://entrapulse-polyarchy/mcp-app.html';

/** _meta helpers — ship both the spec key and the deprecated flat key (Lokka does). */
function uiMeta(visibility: string[], withResource: boolean) {
  return {
    ui: { ...(withResource ? { resourceUri: RESOURCE_URI } : {}), visibility },
    ...(withResource ? { 'ui/resourceUri': RESOURCE_URI } : {})
  };
}

function ok(text: string, structuredContent: Record<string, any>) {
  return { content: [{ type: 'text' as const, text }], structuredContent };
}

function fail(err: any) {
  return {
    content: [{ type: 'text' as const, text: String(err?.message ?? err) }],
    isError: true
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The single hit whose displayName or UPN equals the term (case-insensitive), else null. */
function exactMatch(hits: any[], term: string) {
  const t = term.toLowerCase();
  const exact = hits.filter(
    u => u.displayName?.toLowerCase() === t || u.userPrincipalName?.toLowerCase() === t
  );
  return exact.length === 1 ? exact[0] : null;
}

function candidateFields(u: any) {
  const { id, displayName, userPrincipalName, jobTitle, department } = u;
  return { id, displayName, userPrincipalName, jobTitle, department };
}

/** One text line per user — ids/UPNs must live in the text block, not just
 *  structuredContent, because not every MCP client shows the model the latter. */
function userLines(users: any[]) {
  return users
    .map(candidateFields)
    .map(c => `- ${c.displayName} — ${c.userPrincipalName} — ` +
      `${[c.jobTitle, c.department].filter(Boolean).join(', ') || 'no title'} — ${c.id}`)
    .join('\n');
}

/** Delta rendered for the text block: full ids/labels, trimmed node payloads. */
function deltaText(delta: Delta) {
  const nodes = delta.nodes.map((n) => {
    const base = { id: n.id, type: n.type, label: n.label };
    if (n.type === 'user') {
      const { userPrincipalName, jobTitle, department } = n.data ?? {};
      return { ...base, userPrincipalName, jobTitle, department };
    }
    if (n.type === 'group') {
      const g = reportGroup(n.data ?? {});
      return {
        ...base,
        description: g.description,
        groupType: g.type, // Security / Microsoft 365 / Distribution list / Mail-enabled security
        membership: g.membership,
        ...(g.membershipRule ? { membershipRule: g.membershipRule } : {})
      };
    }
    return base;
  });
  const edges = delta.edges.map(({ source, kind, target }) => ({ source, kind, target }));
  return `${delta.message}\n\`\`\`json\n${JSON.stringify({ nodes, edges }, null, 2)}\n\`\`\``;
}

/** Resolve search/userId to an object id. When resolution can't complete (no match,
 *  ambiguous name) the tool response to return as-is comes back instead. */
async function resolveUser(
  graph: GraphClient,
  toolName: string,
  search: string | undefined,
  userId: string | undefined,
  extra: Record<string, any> = {}
): Promise<{ id?: string; response?: any }> {
  if (userId) return { id: userId };
  if (!search) return {};
  if (GUID.test(search)) return { id: search };
  const hits = await graph.searchUsers(search);
  if (!hits.length) return { response: fail(new Error(`No user matched "${search}".`)) };
  const pick = hits.length === 1 ? hits[0] : exactMatch(hits, search);
  if (pick) return { id: pick.id };
  return {
    response: ok(
      `${hits.length} users match "${search}". Ask the user which one they mean, then ` +
      `call ${toolName} again with that userId.\n${userLines(hits)}`,
      { ...extra, ambiguous: true, candidates: hits.map(candidateFields) }
    )
  };
}

export function registerTools(
  server: McpServer,
  auth: AuthManager,
  graph: GraphClient,
  hasUi: boolean
) {
  // ---------- launcher ----------

  registerAppTool(
    server,
    'visualize-identity',
    {
      title: 'EntraPulse Polyarchy',
      description:
        'Open the interactive Identity Polyarchy — a live relationship graph over Microsoft Entra ID ' +
        '(org hierarchy, groups, shared attributes, roles and app assignments). ' +
        'Call when the user asks to visualize, explore or map identity relationships, or says ' +
        '"open the polyarchy" / "show me the polyarchy around <name>". ' +
        'With no arguments it opens focused on the signed-in user (delegated modes only — ' +
        'in app-only mode pass search or userId). If search matches several people the tool ' +
        'returns the candidates instead of opening — ask the user which one they mean and call ' +
        'again with that userId (or use polyarchy-search first for names you suspect are common). ' +
        'Once opened the UI is interactive; ' +
        'no further action is needed unless the user asks for something new.',
      inputSchema: {
        search: z.string().optional().describe('Name or UPN to find and focus'),
        userId: z.string().optional().describe('Exact Entra object id to focus')
      },
      _meta: uiMeta(['model', 'app'], hasUi)
    },
    async ({ search, userId }: { search?: string; userId?: string }) => {
      try {
        const resolved = await resolveUser(graph, 'visualize-identity', search, userId, {
          polyarchy: 'not-opened'
        });
        if (resolved.response) return resolved.response;
        let focus = resolved.id ?? null;
        if (!focus) {
          if (auth.isAppOnly) {
            return fail(new Error(
              'App-only auth has no signed-in user — call visualize-identity with a search or userId argument.'
            ));
          }
          focus = (await graph.getMe()).id;
        }
        const seedData = await graph.seed(focus!);
        return ok(
          `The interactive polyarchy is now displayed, focused on ${seedData.message}. ` +
          'The user can explore it directly — no further action needed.',
          { polyarchy: 'opened', ...seedData }
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---------- expansion (model + app) ----------

  registerAppTool(
    server,
    'polyarchy-expand',
    {
      title: 'Expand polyarchy node',
      description:
        'Fetch one node\'s relationships from Microsoft Graph as a nodes/edges delta. ' +
        'Dimensions for a user node: org (manager chain + direct reports), groups (memberships), ' +
        'access (directory roles + app assignments), attributes (pivot hub for attr). ' +
        'For nodeType group/role, returns members. For nodeType attribute pass attr+value to load the whole cohort. ' +
        'The delta is returned to the caller only — it does not update an open polyarchy canvas ' +
        '(the UI fetches its own data when the user interacts with it).',
      inputSchema: {
        nodeId: z.string().optional().describe('Entra object id (users, groups, roles); a UPN also works for users'),
        userId: z.string().optional().describe('Alias for nodeId'),
        nodeType: z.enum(['user', 'group', 'role', 'attribute']),
        dimension: z.enum(['org', 'groups', 'access', 'attributes']).optional().default('org'),
        attr: z.string().optional().describe(
          'Attribute name or nested path, e.g. department or onPremisesExtensionAttributes/extensionAttribute9'
        ),
        value: z.string().optional().describe('Attribute value (attribute-cohort expansion)')
      },
      _meta: uiMeta(['model', 'app'], false)
    },
    async ({ nodeId, userId, nodeType, dimension, attr, value }: any) => {
      try {
        let id = nodeId ?? userId;
        if (nodeType !== 'attribute' && !id) {
          return fail(new Error(
            `Expanding a ${nodeType} needs nodeId — its Entra object id ` +
            '(get one from polyarchy-search, polyarchy-report or an earlier expand).'
          ));
        }
        // A UPN works for user lookups, but delta edges must carry the object id.
        if (nodeType === 'user' && id && !GUID.test(id)) id = (await graph.getUser(id)).id;
        let delta: Delta;
        if (nodeType === 'attribute') {
          if (!attr || value === undefined) return fail(new Error('attribute expansion needs attr and value'));
          delta = await graph.expandAttributeCohort(attr, value);
        } else if (nodeType === 'group') {
          delta = await graph.expandGroup(id);
        } else if (nodeType === 'role') {
          delta = await graph.expandRole(id);
        } else if (dimension === 'groups') {
          delta = await graph.expandUserGroups(id);
        } else if (dimension === 'access') {
          delta = await graph.expandUserAccess(id);
        } else if (dimension === 'attributes') {
          if (!attr) return fail(new Error('attributes dimension needs attr'));
          delta = await graph.expandUserAttribute(id, attr);
        } else {
          delta = await graph.expandUserOrg(id);
        }
        return ok(deltaText(delta), delta as unknown as Record<string, any>);
      } catch (err) {
        return fail(err);
      }
    }
  );

  registerAppTool(
    server,
    'polyarchy-search',
    {
      title: 'Search people',
      description: 'Search Entra ID users by name or UPN (top 15 matches with core attributes).',
      inputSchema: { term: z.string().min(2) },
      _meta: uiMeta(['model', 'app'], false)
    },
    async ({ term }: { term: string }) => {
      try {
        const users = await graph.searchUsers(term);
        const text = users.length
          ? `${users.length} match(es) for "${term}":\n${userLines(users)}`
          : `No users matched "${term}".`;
        return ok(text, { users });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---------- structured report (model-facing, works headless) ----------

  registerAppTool(
    server,
    'polyarchy-report',
    {
      title: 'Identity relationship report',
      description:
        "Structured JSON report of one user's identity relationships — no UI needed, works headless. " +
        'Dimensions: org (full manager chain to the root + direct reports), groups (direct memberships ' +
        'with group type — Security / Microsoft 365 / Distribution list / Mail-enabled security — and ' +
        'assigned vs dynamic membership), roles (directory roles), applications (app assignments), ' +
        'attributes (core profile values), or all (default). ' +
        'Use when the user wants analysis, a summary or the underlying data — after exploring the ' +
        'polyarchy visually, or instead of opening it. With no person argument it reports on the ' +
        'signed-in user (delegated modes only). Ambiguous names return candidates — re-call with userId.',
      inputSchema: {
        search: z.string().optional().describe('Name or UPN to find'),
        userId: z.string().optional().describe('Exact Entra object id'),
        dimensions: z
          .array(z.enum(['org', 'groups', 'roles', 'applications', 'attributes', 'all']))
          .optional()
          .describe('Relationship categories to include (default: all)')
      },
      _meta: uiMeta(['model'], false)
    },
    async ({ search, userId, dimensions }: {
      search?: string; userId?: string; dimensions?: string[];
    }) => {
      try {
        const resolved = await resolveUser(graph, 'polyarchy-report', search, userId);
        if (resolved.response) return resolved.response;
        let id = resolved.id ?? null;
        if (!id) {
          if (auth.isAppOnly) {
            return fail(new Error(
              'App-only auth has no signed-in user — call polyarchy-report with a search or userId argument.'
            ));
          }
          id = (await graph.getMe()).id;
        }
        const report = await graph.report(id!, dimensions?.length ? dimensions : ['all']);
        return ok(
          `Identity report for ${report.user.displayName} (${report.user.userPrincipalName}):\n` +
          '```json\n' + JSON.stringify(report, null, 2) + '\n```',
          report
        );
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---------- app-only backend for the iframe ----------

  registerAppTool(
    server,
    'get-photo',
    {
      description: 'Photo for a user as a data: URI (48x48), or null.',
      inputSchema: { userId: z.string() },
      _meta: uiMeta(['app'], false)
    },
    async ({ userId }: { userId: string }) => {
      const dataUri = await graph.getPhotoDataUri(userId);
      return ok(dataUri ? 'photo' : 'no photo', { dataUri });
    }
  );

  registerAppTool(
    server,
    'get-manager',
    {
      description: "A user's manager (core attributes), or null at the top of the chain.",
      inputSchema: { userId: z.string() },
      _meta: uiMeta(['app'], false)
    },
    async ({ userId }: { userId: string }) => {
      try {
        const manager = await graph.getManager(userId);
        return ok(manager ? manager.displayName : 'no manager', { manager });
      } catch (err) {
        return fail(err);
      }
    }
  );

  // ---------- auth utilities ----------

  registerAppTool(
    server,
    'set-access-token',
    {
      description:
        'Provide/refresh a Microsoft Graph bearer token when the server runs with USE_CLIENT_TOKEN=true ' +
        '(e.g. EntraPulse passing its own token for seamless SSO). expiresOn is ISO 8601; defaults to the ' +
        "token's exp claim or 1 hour.",
      inputSchema: {
        accessToken: z.string(),
        expiresOn: z.string().optional()
      },
      _meta: uiMeta(['model', 'app'], false)
    },
    async ({ accessToken, expiresOn }: { accessToken: string; expiresOn?: string }) => {
      try {
        auth.setAccessToken(accessToken, expiresOn);
        return ok('Access token updated.', { updated: true });
      } catch (err) {
        return fail(err);
      }
    }
  );

  registerAppTool(
    server,
    'get-auth-status',
    {
      description:
        'Current auth mode, signed-in account, client app id, decoded token scopes/roles, and token expiry ' +
        '(expiresOn + tokenExpiresInMinutes; renewal is silent) — use to diagnose 401/403s and missing consent.',
      inputSchema: {},
      _meta: uiMeta(['model', 'app'], false)
    },
    async () => {
      const status = auth.status();
      return ok(
        `mode=${status.mode} signedIn=${status.signedIn} account=${status.account ?? 'n/a'}`,
        status
      );
    }
  );
}
