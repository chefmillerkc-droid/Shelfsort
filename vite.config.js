import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // pdf.js uses top-level await; modern browsers / WebViews support it.
  build: { target: 'esnext' },
})
