import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
    css: false,
    // Vitest never loads .env.local; give the app a dummy key so Gemini code paths run (fetch is always mocked)
    env: { VITE_GEMINI_API_KEY: 'test-key' },
    restoreMocks: true,
  },
})
