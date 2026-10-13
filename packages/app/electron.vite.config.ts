import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// @orquestra/shared é TypeScript sem build: precisa ser empacotado, não externalizado.
const workspace = ['@orquestra/shared'];

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin({ exclude: workspace })] },
  preload: { plugins: [externalizeDepsPlugin({ exclude: workspace })] },
  renderer: { plugins: [react()] },
});
