import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative asset paths so the built app works when hosted under a
  // subpath (e.g. GitHub Pages at /Shelfsort/) as well as at a root.
  base: './',
  plugins: [react()],
  // pdf.js uses top-level await; modern browsers / WebViews support it.
  build: { target: 'esnext' },
})
