import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// CLEAN CONFIG WITHOUT PWA

export default defineConfig({
  plugins: [
    react(),
  ],
  build: {
    outDir: 'dist',
  },
})
