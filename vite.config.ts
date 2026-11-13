import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs: the dist/ folder works from any sub-path or portal iframe (CrazyGames folder upload).
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
  },
  server: { port: 5173 },
});
