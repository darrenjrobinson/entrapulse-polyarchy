// Server-side Microsoft Graph layer — port of the former SPA graph client
// (fetch + Retry-After handling + paging) with delta builders that return
// {nodes, edges} in the exact shape the app's store consumes.

import { AuthManager } from './auth.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MAX_RETRIES = 3;

export const USER_FIELDS = [
  'id', 'displayName', 'userPrincipalName', 'mail', 'jobTitle', 'department',
  'companyName', 'city', 'state', 'officeLocation', 'employeeType', 'userType',
  'accountEnabled'
].join(',');

const SELECT = `$select=${USER_FIELDS}`;

export interface GraphNode {
  id: string;
  type: 'user' | 'group' | 'role' | 'servicePrincipal' | 'attribute';
  label: string;
  data: Record<string, any>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'reportsTo' | 'memberOf' | 'hasRole' | 'assignedApp' | 'attribute';
}

export interface Delta {
  nodes: GraphNode[];
  edges: GraphEdge[];
  message: string;
}

function userNode(u: any): GraphNode {
  return { id: u.id, type: 'user', label: u.displayName ?? u.userPrincipalName ?? u.id, data: u };
}

function groupNode(g: any): GraphNode {
  return { id: g.id, type: 'group', label: g.displayName ?? g.id, data: g };
}

function roleNode(r: any): GraphNode {
  return { id: r.id, type: 'role', label: r.displayName ?? r.id, data: r };
}

function spNode(sp: any): GraphNode {
  return { id: sp.id, type: 'servicePrincipal', label: sp.displayName ?? sp.id, data: sp };
}

function attributeNode(attr: string, value: string): GraphNode {
  return {
    id: `attr:${attr}:${value}`,
    type: 'attribute',
    label: String(value),
    data: { attr, value, description: `Everyone sharing ${attr} = “${value}”` }
  };
}

function edge(source: string, kind: GraphEdge['kind'], target: string): GraphEdge {
  return { id: `${source}|${kind}|${target}`, source, target, kind };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pivot attributes may be nested paths like onPremisesExtensionAttributes/
// extensionAttribute9 — $select takes the first segment, the rest resolves in
// JS. The shape is validated because the attr lands inside an OData $filter.
const ATTR_PATH = /^[A-Za-z][A-Za-z0-9]*(\/[A-Za-z][A-Za-z0-9]*)?$/;

function assertAttrPath(attr: string) {
  if (!ATTR_PATH.test(attr)) {
    throw new Error(
      `Invalid attribute path "${attr}" — expected a Graph user property like ` +
      `department or onPremisesExtensionAttributes/extensionAttribute9.`
    );
  }
}

const attrSelectField = (attr: string) => attr.split('/')[0];

const attrValueOf = (obj: any, attr: string) =>
  attr.split('/').reduce((o, k) => o?.[k], obj);

export class GraphClient {
  constructor(private auth: AuthManager) {}

  private apiCalls = 0;
  get apiCallCount() { return this.apiCalls; }

  async gfetch(
    path: string,
    opts: { advanced?: boolean; tolerate404?: boolean; raw?: boolean } = {}
  ): Promise<any> {
    const token = await this.auth.getGraphToken();
    const url = path.startsWith('http') ? path : GRAPH_BASE + path;

    for (let attempt = 0; ; attempt++) {
      this.apiCalls++;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.advanced ? { ConsistencyLevel: 'eventual' } : {})
        }
      });

      if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
        const wait = Number(res.headers.get('Retry-After')) || 2 ** attempt;
        await sleep(wait * 1000);
        continue;
      }
      if (res.status === 404 && opts.tolerate404) return null;
      if (res.status === 204) return null;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err: any = new Error(graphErrorMessage(res.status, path, body));
        err.status = res.status;
        throw err;
      }
      return opts.raw ? res : res.json();
    }
  }

  async getAll(path: string, opts: { advanced?: boolean } = {}): Promise<any[]> {
    const items: any[] = [];
    let next: string | null = path;
    while (next) {
      const page = await this.gfetch(next, opts);
      if (!page) break;
      items.push(...(page.value ?? []));
      next = page['@odata.nextLink'] ?? null;
    }
    return items;
  }

  // ---------- queries ----------

  getMe() {
    return this.gfetch(`/me?${SELECT}`);
  }

  getUser(id: string) {
    return this.gfetch(`/users/${id}?${SELECT}`);
  }

  async getManager(id: string) {
    return this.gfetch(`/users/${id}/manager?${SELECT}`, { tolerate404: true });
  }

  async getManagerChain(id: string): Promise<any[]> {
    const chain: any[] = [];
    const seen = new Set([id]);
    let current = id;
    while (true) {
      const mgr = await this.getManager(current);
      if (!mgr || seen.has(mgr.id)) break; // top of chain, or a cycle in dirty data
      chain.push(mgr);
      seen.add(mgr.id);
      current = mgr.id;
    }
    return chain;
  }

  getDirectReports(id: string) {
    return this.getAll(`/users/${id}/directReports?${SELECT}`);
  }

  async getMemberships(id: string) {
    const items = await this.getAll(
      `/users/${id}/memberOf?$select=id,displayName,description,groupTypes,mailEnabled,securityEnabled`
    );
    return {
      groups: items.filter((o) => o['@odata.type'] === '#microsoft.graph.group'),
      roles: items.filter((o) => o['@odata.type'] === '#microsoft.graph.directoryRole')
    };
  }

  async getGroupMembers(groupId: string) {
    const items = await this.getAll(`/groups/${groupId}/members?${SELECT}`);
    return items.filter((o) => o['@odata.type'] === '#microsoft.graph.user');
  }

  async getRoleMembers(roleId: string) {
    const items = await this.getAll(`/directoryRoles/${roleId}/members?${SELECT}`);
    return items.filter((o) => o['@odata.type'] === '#microsoft.graph.user');
  }

  getAppRoleAssignments(userId: string) {
    return this.getAll(`/users/${userId}/appRoleAssignments`);
  }

  async searchUsers(term: string): Promise<any[]> {
    const q = encodeURIComponent(`"displayName:${term}" OR "userPrincipalName:${term}"`);
    const page = await this.gfetch(`/users?$search=${q}&${SELECT}&$top=15`, { advanced: true });
    return page?.value ?? [];
  }

  getUsersByAttribute(attr: string, value: string) {
    assertAttrPath(attr);
    const filter = encodeURIComponent(`${attr} eq '${String(value).replace(/'/g, "''")}'`);
    // cohort members carry the pivot attribute too, so client-side re-pivots see it
    return this.getAll(
      `/users?$filter=${filter}&$count=true&${SELECT},${attrSelectField(attr)}`,
      { advanced: true }
    );
  }

  /** 48x48 photo as a data: URI (CSP-allowed in the iframe), or null. */
  async getPhotoDataUri(userId: string): Promise<string | null> {
    try {
      const res: Response | null = await this.gfetch(`/users/${userId}/photos/48x48/$value`, {
        raw: true,
        tolerate404: true
      });
      if (!res) return null;
      const contentType = res.headers.get('Content-Type') ?? 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      return `data:${contentType};base64,${buf.toString('base64')}`;
    } catch {
      return null; // 401/403 in some tenants — the app falls back to initials
    }
  }

  // ---------- delta builders (mirror the former SPA expandNode dispatch) ----------

  async expandUserOrg(userId: string): Promise<Delta> {
    const user = await this.getUser(userId);
    const [chain, reports] = await Promise.all([
      this.getManagerChain(userId),
      this.getDirectReports(userId)
    ]);
    const nodes: GraphNode[] = [userNode(user)];
    const edges: GraphEdge[] = [];
    let childId = userId;
    for (const mgr of chain) {
      nodes.push(userNode(mgr));
      edges.push(edge(childId, 'reportsTo', mgr.id));
      childId = mgr.id;
    }
    for (const r of reports) {
      nodes.push(userNode(r));
      edges.push(edge(r.id, 'reportsTo', userId));
    }
    return { nodes, edges, message: `${user.displayName}: ${chain.length} up, ${reports.length} down` };
  }

  async expandUserGroups(userId: string): Promise<Delta> {
    const { groups } = await this.getMemberships(userId);
    return {
      nodes: groups.map(groupNode),
      edges: groups.map((g) => edge(userId, 'memberOf', g.id)),
      message: `${groups.length} group${groups.length === 1 ? '' : 's'}`
    };
  }

  async expandUserAccess(userId: string): Promise<Delta> {
    const [{ roles }, assignments] = await Promise.all([
      this.getMemberships(userId),
      this.getAppRoleAssignments(userId)
    ]);
    const nodes: GraphNode[] = [
      ...roles.map(roleNode),
      ...assignments.map((a: any) => spNode({ id: a.resourceId, displayName: a.resourceDisplayName }))
    ];
    const edges: GraphEdge[] = [
      ...roles.map((r) => edge(userId, 'hasRole', r.id)),
      ...assignments.map((a: any) => edge(userId, 'assignedApp', a.resourceId))
    ];
    return { nodes, edges, message: `${roles.length} roles, ${assignments.length} apps` };
  }

  async expandUserAttribute(userId: string, attr: string): Promise<Delta> {
    assertAttrPath(attr);
    const user = await this.gfetch(`/users/${userId}?${SELECT},${attrSelectField(attr)}`);
    const value = attrValueOf(user, attr);
    if (!value) return { nodes: [], edges: [], message: `${user.displayName} has no ${attr}` };
    const hub = attributeNode(attr, value);
    return {
      nodes: [hub],
      edges: [edge(userId, 'attribute', hub.id)],
      message: `${attr}: ${value}`
    };
  }

  async expandGroup(groupId: string): Promise<Delta> {
    const members = await this.getGroupMembers(groupId);
    return {
      nodes: members.map(userNode),
      edges: members.map((m) => edge(m.id, 'memberOf', groupId)),
      message: `${members.length} members`
    };
  }

  async expandRole(roleId: string): Promise<Delta> {
    const members = await this.getRoleMembers(roleId);
    return {
      nodes: members.map(userNode),
      edges: members.map((m) => edge(m.id, 'hasRole', roleId)),
      message: `${members.length} members`
    };
  }

  async expandAttributeCohort(attr: string, value: string): Promise<Delta> {
    const cohort = await this.getUsersByAttribute(attr, value);
    const hub = attributeNode(attr, value);
    return {
      nodes: [hub, ...cohort.map(userNode)],
      edges: cohort.map((u) => edge(u.id, 'attribute', hub.id)),
      message: `${attr}: ${value} — ${cohort.length} people`
    };
  }

  /** Seed graph for visualize-identity: focus + org neighborhood. */
  async seed(userId: string): Promise<Delta & { focusId: string }> {
    const delta = await this.expandUserOrg(userId);
    return { ...delta, focusId: userId };
  }
}

/** Errors double as model guidance (the Lokka pattern). */
function graphErrorMessage(status: number, path: string, body: string): string {
  const detail = body.slice(0, 300);
  if (status === 401) {
    return `Graph returned 401 (not signed in or token expired) on ${path}. ` +
      `Tell the user a sign-in is required — in interactive mode a browser window opens on retry; ` +
      `in token mode call set-access-token with a fresh token. Detail: ${detail}`;
  }
  if (status === 403) {
    return `Graph returned 403 (missing permission) on ${path}. ` +
      `The signed-in identity lacks a required scope — likely User.Read.All, Group.Read.All, ` +
      `RoleManagement.Read.Directory or Application.Read.All depending on the view. ` +
      `Explain which consent is missing. Detail: ${detail}`;
  }
  return `Graph ${status} on ${path}: ${detail}`;
}
