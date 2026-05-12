import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // `@/` resolves to `web/src/` — matches the shadcn / AI Elements
  // convention and the path alias in tsconfig.json. Required so the
  // `@/components/ai-elements/*` imports in installed AI Elements
  // components resolve at build time.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: { port: 5173 },
});
