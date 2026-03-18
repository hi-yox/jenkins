import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: '0.0.0.0',
    port: 8080,
    strictPort: true,
    proxy: {
      '/api': 'http://130.94.33.164:8081',
      '/downloads': 'http://130.94.33.164:8081'
    }
  },
  preview: {
    host: '0.0.0.0',
    port: 8080,
    strictPort: true
  }
});
