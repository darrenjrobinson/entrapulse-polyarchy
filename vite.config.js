import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Builds the MCP App UI into ONE self-contained HTML file (all JS/CSS inlined)
// so it satisfies the MCP Apps default CSP with no external resources.
export default defineConfig({
  root: 'src/app',
  plugins: [viteSingleFile()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  build: {
    outDir: '../../build/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/app/mcp-app.html'
    }
  }
});
