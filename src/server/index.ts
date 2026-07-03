#!/usr/bin/env node
// EntraPulse Polyarchy — MCP server serving an interactive Entra ID identity
// relationship visualization as an MCP App (io.modelcontextprotocol/ui).

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { AuthManager } from './auth.js';
import { GraphClient } from './graph.js';
import { registerTools, RESOURCE_URI } from './tools.js';

const VERSION = (() => {
  try {
    // works from dev checkout and npm tarball alike
    return JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
    ).version as string;
  } catch {
    return '0.0.0';
  }
})();

const appHtml = (() => {
  try {
    return readFileSync(new URL('../ui/mcp-app.html', import.meta.url), 'utf-8');
  } catch {
    console.error(
      '[polyarchy] build/ui/mcp-app.html missing — tools still work but no interactive app will render. ' +
      'Run `npm run build:app`.'
    );
    return null;
  }
})();

const server = new McpServer({ name: 'entrapulse-polyarchy', version: VERSION });
const auth = new AuthManager();
const graph = new GraphClient(auth);

if (appHtml) {
  const uiResourceMeta = {
    ui: {
      // No external network access: the app fetches everything via tools/call.
      csp: { connectDomains: [], resourceDomains: [] },
      prefersBorder: true
    }
  };
  registerAppResource(
    server,
    'polyarchy-app',
    RESOURCE_URI,
    {
      title: 'EntraPulse Polyarchy',
      description: 'Interactive Entra ID identity relationship graph',
      mimeType: RESOURCE_MIME_TYPE,
      _meta: uiResourceMeta
    },
    async () => ({
      contents: [
        { uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: appHtml, _meta: uiResourceMeta }
      ]
    })
  );
}

registerTools(server, auth, graph, !!appHtml);

server.registerPrompt(
  'open-polyarchy',
  {
    title: 'Open EntraPulse Polyarchy',
    description: 'Open the interactive Entra ID identity relationship visualization'
  },
  () => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: 'Open the EntraPulse Polyarchy visualization focused on me.'
        }
      }
    ]
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[polyarchy] entrapulse-polyarchy v${VERSION} ready on stdio (auth: ${auth.mode})`);
