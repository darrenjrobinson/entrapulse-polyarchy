// Multi-mode Microsoft Graph auth, patterned on Lokka 2.1.x.
// stdio transport: NEVER write to stdout here — all logging via console.error.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  InteractiveBrowserCredential,
  DeviceCodeCredential,
  ClientSecretCredential,
  useIdentityPlugin,
  serializeAuthenticationRecord,
  deserializeAuthenticationRecord,
  type AuthenticationRecord,
  type TokenCredential,
  type AccessToken,
  type InteractiveBrowserCredentialNodeOptions,
  type DeviceCodeCredentialOptions
} from '@azure/identity';

export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

// Microsoft's first-party multi-tenant "Microsoft Graph Command Line Tools"
// public client — present/consented in most tenants, so users need no app
// registration for delegated sign-in (the Lokka zero-setup pattern).
const GRAPH_CLI_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const DEFAULT_TENANT = 'common';
const DEFAULT_REDIRECT_URI = 'http://localhost:3000';
const CACHE_NAME = 'entrapulse-polyarchy';

export type AuthMode = 'interactive' | 'device_code' | 'client_credentials' | 'client_provided_token';

/** TokenCredential over a raw bearer token fed by the MCP client (EntraPulse SSO). */
class ClientProvidedTokenCredential implements TokenCredential {
  private token: string | null = null;
  private expiresOnTimestamp = 0;

  setToken(accessToken: string, expiresOn?: string) {
    this.token = accessToken;
    if (expiresOn) {
      this.expiresOnTimestamp = Date.parse(expiresOn);
    } else {
      const exp = decodeJwtPayload(accessToken)?.exp;
      this.expiresOnTimestamp = exp ? exp * 1000 : Date.now() + 60 * 60 * 1000; // default TTL 1h
    }
  }

  async getToken(): Promise<AccessToken | null> {
    if (!this.token) return null;
    if (Date.now() >= this.expiresOnTimestamp) {
      throw new Error(
        'The client-provided access token has expired. Call the set-access-token tool with a fresh token.'
      );
    }
    return { token: this.token, expiresOnTimestamp: this.expiresOnTimestamp };
  }
}

/** Decode a JWT payload without verification (diagnostics only). */
export function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

// The OS token cache stores refresh tokens, but a new process also needs the
// AuthenticationRecord (which account to use) to redeem them silently —
// without it every fresh server spawn re-prompts even with a warm cache.
const AUTH_RECORD_PATH =
  process.env.POLYARCHY_AUTH_RECORD ??
  join(homedir(), '.entrapulse-polyarchy', 'auth-record.json');

// Auth diagnostics: MCP clients bury stderr, so mirror auth events to a file.
// Silent token acquisitions run in milliseconds; interactive flows take seconds
// — the timings in this log tell them apart at a glance.
const AUTH_LOG_PATH = join(dirname(AUTH_RECORD_PATH), 'auth.log');

function authLog(msg: string) {
  const line = `${new Date().toISOString()} pid=${process.pid} ${msg}`;
  console.error(`[polyarchy] ${line}`);
  fs.mkdir(dirname(AUTH_LOG_PATH), { recursive: true })
    .then(() => fs.appendFile(AUTH_LOG_PATH, line + '\n', 'utf-8'))
    .catch(() => {});
}

async function loadAuthRecord(): Promise<AuthenticationRecord | undefined> {
  try {
    return deserializeAuthenticationRecord(await fs.readFile(AUTH_RECORD_PATH, 'utf-8'));
  } catch {
    return undefined;
  }
}

async function saveAuthRecord(record: AuthenticationRecord) {
  try {
    await fs.mkdir(dirname(AUTH_RECORD_PATH), { recursive: true });
    await fs.writeFile(AUTH_RECORD_PATH, serializeAuthenticationRecord(record), 'utf-8');
  } catch (err) {
    console.error('[polyarchy] could not save auth record:', (err as Error).message);
  }
}

let cachePersistenceLoaded = false;

async function tokenCacheOptions() {
  if (process.env.POLYARCHY_DISABLE_TOKEN_CACHE === 'true') return undefined;
  if (!cachePersistenceLoaded) {
    try {
      const { cachePersistencePlugin } = await import('@azure/identity-cache-persistence');
      useIdentityPlugin(cachePersistencePlugin);
      cachePersistenceLoaded = true;
    } catch (err) {
      console.error(
        '[polyarchy] OS token cache unavailable (sign-in will not persist across restarts):',
        (err as Error).message
      );
      return undefined;
    }
  }
  return { enabled: true, name: CACHE_NAME };
}

export class AuthManager {
  readonly mode: AuthMode;
  private credential: TokenCredential | null = null;
  private readonly clientTokenCredential = new ClientProvidedTokenCredential();
  private lastToken: string | null = null;
  private cachedToken: AccessToken | null = null;
  private inflight: Promise<string> | null = null;

  constructor() {
    const env = process.env;
    if (env.USE_CLIENT_TOKEN === 'true') {
      this.mode = 'client_provided_token';
      if (env.ACCESS_TOKEN) this.clientTokenCredential.setToken(env.ACCESS_TOKEN);
      this.credential = this.clientTokenCredential;
    } else if (env.USE_DEVICE_CODE === 'true') {
      this.mode = 'device_code';
    } else if (env.TENANT_ID && env.CLIENT_ID && env.CLIENT_SECRET) {
      this.mode = 'client_credentials';
    } else {
      this.mode = 'interactive';
    }
    console.error(`[polyarchy] auth mode: ${this.mode}`);
  }

  get isAppOnly(): boolean {
    if (this.mode === 'client_credentials') return true;
    if (this.mode === 'client_provided_token' && this.lastToken) {
      const claims = decodeJwtPayload(this.lastToken);
      return !!claims && !claims.scp; // app-only tokens carry roles, not scp
    }
    return false;
  }

  setAccessToken(accessToken: string, expiresOn?: string) {
    if (this.mode !== 'client_provided_token') {
      throw new Error(
        'set-access-token only applies when the server runs with USE_CLIENT_TOKEN=true.'
      );
    }
    this.clientTokenCredential.setToken(accessToken, expiresOn);
    this.lastToken = accessToken;
    this.cachedToken = null; // next call must pick up the new token
  }

  /** Lazily build the credential — sign-in happens on first Graph call, not launch. */
  private async buildCredential(): Promise<TokenCredential> {
    const env = process.env;
    if (this.mode === 'client_credentials') {
      return new ClientSecretCredential(env.TENANT_ID!, env.CLIENT_ID!, env.CLIENT_SECRET!, {
        tokenCachePersistenceOptions: await tokenCacheOptions()
      });
    }
    return this.buildDelegatedCredential(this.mode === 'device_code' ? 'device_code' : 'interactive');
  }

  /**
   * Delegated credential wired for cross-process silent sign-in: a stored
   * AuthenticationRecord plus the OS token cache lets a freshly spawned server
   * (MCP clients respawn stdio servers freely) reuse the previous sign-in
   * instead of prompting again.
   */
  private async buildDelegatedCredential(kind: 'interactive' | 'device_code'): Promise<TokenCredential> {
    const env = process.env;
    const tenantId = env.TENANT_ID || DEFAULT_TENANT;
    const clientId = env.CLIENT_ID || GRAPH_CLI_CLIENT_ID;
    const cache = await tokenCacheOptions();
    const record = cache ? await loadAuthRecord() : undefined;
    authLog(
      `building ${kind} credential: tenant=${tenantId} client=${clientId} ` +
      `cache=${cache ? 'on' : 'OFF'} record=${record ? record.username : 'NONE'}`
    );

    let credential: InteractiveBrowserCredential | DeviceCodeCredential;
    if (kind === 'device_code') {
      const options: DeviceCodeCredentialOptions = {
        tenantId,
        clientId,
        tokenCachePersistenceOptions: cache,
        authenticationRecord: record,
        userPromptCallback: (info) => console.error(`[polyarchy] ${info.message}`)
      };
      credential = new DeviceCodeCredential(options);
    } else {
      const options: InteractiveBrowserCredentialNodeOptions = {
        tenantId,
        clientId,
        redirectUri: env.REDIRECT_URI || DEFAULT_REDIRECT_URI,
        tokenCachePersistenceOptions: cache,
        authenticationRecord: record
      };
      credential = new InteractiveBrowserCredential(options);
    }

    // First sign-in on this machine: authenticate now and keep the record so
    // every later spawn is silent. Pointless without the persistent cache.
    if (cache && !record) {
      authLog('no auth record — starting first-time interactive sign-in');
      const fresh = await credential.authenticate(GRAPH_SCOPE);
      if (fresh) await saveAuthRecord(fresh);
      authLog(`first-time sign-in complete: ${fresh?.username ?? 'unknown account'}`);
    }
    return credential;
  }

  /**
   * Concurrency-safe token access. A focus flip fires an org expansion plus a
   * photo fetch per node — a dozen-plus Graph calls at once. Letting each of
   * them run credential.getToken() concurrently races MSAL's persistent-cache
   * lock; the loser sees a cache miss and InteractiveBrowserCredential answers
   * a miss with a browser prompt. Serve a cached token while it's fresh and
   * single-flight the actual acquisition so MSAL only ever sees one caller.
   */
  async getGraphToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresOnTimestamp - 5 * 60_000) {
      return this.cachedToken.token;
    }
    if (!this.inflight) {
      this.inflight = this.acquireGraphToken().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async acquireGraphToken(): Promise<string> {
    const t0 = Date.now();
    try {
      if (!this.credential) this.credential = await this.buildCredential();
      const result = await this.credential.getToken(GRAPH_SCOPE);
      if (!result) throw new Error('No token returned');
      const ms = Date.now() - t0;
      // >2s means a human was involved — a silent cache hit never takes that long.
      authLog(`token acquired in ${ms}ms (${ms > 2000 ? 'INTERACTIVE?' : 'silent'})`);
      this.cachedToken = result;
      this.lastToken = result.token;
      return result.token;
    } catch (err) {
      // Interactive browser flow can fail headless — fall back to device code once.
      if (this.mode === 'interactive' && !(this.credential instanceof DeviceCodeCredential)) {
        console.error(
          '[polyarchy] interactive browser sign-in failed, falling back to device code:',
          (err as Error).message
        );
        this.credential = await this.buildDelegatedCredential('device_code');
        const result = await this.credential.getToken(GRAPH_SCOPE);
        if (!result) throw new Error('No token returned from device code flow');
        this.cachedToken = result;
        this.lastToken = result.token;
        return result.token;
      }
      throw err;
    }
  }

  status() {
    const claims = this.lastToken ? decodeJwtPayload(this.lastToken) : null;
    return {
      mode: this.mode,
      signedIn: !!this.lastToken,
      appOnly: this.isAppOnly,
      // which app registration this session runs under (default: Graph CLI Tools)
      clientAppId: claims?.appid ?? process.env.CLIENT_ID ?? GRAPH_CLI_CLIENT_ID,
      tenantId: claims?.tid ?? null,
      account: claims?.upn ?? claims?.preferred_username ?? claims?.app_displayname ?? null,
      scopes: claims?.scp ? String(claims.scp).split(' ') : [],
      roles: Array.isArray(claims?.roles) ? claims.roles : [],
      expiresOn: claims?.exp ? new Date(claims.exp * 1000).toISOString() : null
    };
  }
}
