import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('./app/renderer', import.meta.url))

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./out/renderer', import.meta.url)),
    emptyOutDir: true,
    // No inline <script>/<style>: the strict CSP only allows 'self'.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
})
