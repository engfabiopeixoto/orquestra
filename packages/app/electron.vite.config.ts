import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// @orquestra/shared é TypeScript sem build: precisa ser empacotado, não externalizado.
const workspace = ['@orquestra/shared'];

// electron-vite@5 referencia BuildEnvironmentOptions (Vite 6+), ausente nos tipos de vite@5.
const minified = { minify: true } as Record<string, unknown>;

export default defineConfig({
  main: { build: minified, plugins: [externalizeDepsPlugin({ exclude: workspace })] },
  preload: { build: minified, plugins: [externalizeDepsPlugin({ exclude: workspace })] },
  renderer: { build: minified, plugins: [react()] },
});
