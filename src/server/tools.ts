import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { AuthManager } from './auth.js';
import { GraphClient, type Delta } from './graph.js';

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
        'in app-only mode pass search or userId). Once opened the UI is interactive; ' +
        'no further action is needed unless the user asks for something new.',
      inputSchema: {
        search: z.string().optional().describe('Name or UPN to find and focus'),
        userId: z.string().optional().describe('Exact Entra object id to focus')
      },
      _meta: uiMeta(['model', 'app'], hasUi)
    },
    async ({ search, userId }: { search?: string; userId?: string }) => {
      try {
        let focus = userId ?? null;
        if (!focus && search) {
          const hits = await graph.searchUsers(search);
          if (!hits.length) return fail(new Error(`No user matched "${search}".`));
          focus = hits[0].id;
        }
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
        'For nodeType group/role, returns members. For nodeType attribute pass attr+value to load the whole cohort.',
      inputSchema: {
        nodeId: z.string().optional().describe('Entra object id (users, groups, roles)'),
        nodeType: z.enum(['user', 'group', 'role', 'attribute']),
        dimension: z.enum(['org', 'groups', 'access', 'attributes']).optional().default('org'),
        attr: z.string().optional().describe(
          'Attribute name or nested path, e.g. department or onPremisesExtensionAttributes/extensionAttribute9'
        ),
        value: z.string().optional().describe('Attribute value (attribute-cohort expansion)')
      },
      _meta: uiMeta(['model', 'app'], false)
    },
    async ({ nodeId, nodeType, dimension, attr, value }: any) => {
      try {
        let delta: Delta;
        if (nodeType === 'attribute') {
          if (!attr || value === undefined) return fail(new Error('attribute expansion needs attr and value'));
          delta = await graph.expandAttributeCohort(attr, value);
        } else if (nodeType === 'group') {
          delta = await graph.expandGroup(nodeId);
        } else if (nodeType === 'role') {
          delta = await graph.expandRole(nodeId);
        } else if (dimension === 'groups') {
          delta = await graph.expandUserGroups(nodeId);
        } else if (dimension === 'access') {
          delta = await graph.expandUserAccess(nodeId);
        } else if (dimension === 'attributes') {
          if (!attr) return fail(new Error('attributes dimension needs attr'));
          delta = await graph.expandUserAttribute(nodeId, attr);
        } else {
          delta = await graph.expandUserOrg(nodeId);
        }
        return ok(delta.message, delta as unknown as Record<string, any>);
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
        return ok(`${users.length} match(es) for "${term}"`, { users });
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
        'Current auth mode, signed-in account, and decoded token scopes/roles — use to diagnose 401/403s ' +
        'and missing consent.',
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
