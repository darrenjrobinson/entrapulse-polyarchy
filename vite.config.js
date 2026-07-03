import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds the MCP App UI into ONE self-contained HTML file (all JS/CSS inlined)
// so it satisfies the MCP Apps default CSP with no external resources.
export default defineConfig({
  root: 'src/app',
  plugins: [viteSingleFile()],
  build: {
    outDir: '../../build/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/app/mcp-app.html'
    }
  }
});
