import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [vue(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      proxy: {
        '/api': { target: env.BILLING_API_TARGET || 'http://127.0.0.1:3300', changeOrigin: true },
      },
    },
    preview: {
      proxy: {
        '/api': { target: env.BILLING_API_TARGET || 'http://127.0.0.1:3300', changeOrigin: true },
      },
    },
  };
});
