import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    allowedHosts: ['.ngrok-free.dev', '.ngrok.io', '.trycloudflare.com'],
    proxy: {
      '/plan': 'http://localhost:8005',
      '/execute': 'http://localhost:8005',
      '/run': 'http://localhost:8005',
      '/health': 'http://localhost:8005',
      '/dataset': 'http://localhost:8005',
    }
  }
})
