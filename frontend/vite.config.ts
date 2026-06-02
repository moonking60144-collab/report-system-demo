import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 本機開發：apiClient baseURL 為相對路徑 "/api"（給 single-service 部署同源用）。
    // dev 時前端跑 5173 / 後端跑 3000，要靠 proxy 把 5173/api/* 轉去 3000。
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
