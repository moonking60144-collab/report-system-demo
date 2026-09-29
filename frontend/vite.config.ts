import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { randomUUID } from 'node:crypto'

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const buildId = command === 'build' ? randomUUID() : ''
  return {
    define: { 'import.meta.env.VITE_FRONTEND_BUILD_ID': JSON.stringify(buildId) },
    plugins: [react(), {
      name: 'frontend-build-version',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId }) })
      },
    }],
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            antd: ['antd', '@ant-design/icons'],
          },
        },
      },
    },
  }
})
