import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://130.94.33.164:8081',
      '/downloads': 'http://130.94.33.164:8081'
    }
  }
});
