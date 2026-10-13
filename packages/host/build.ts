import { build } from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
export const HOST_SCRIPT = join(here, 'dist', 'host.mjs');

// Os pacotes do workspace são TypeScript sem build: entram no bundle. Módulos nativos e os que
// carregam workers (pino-roll) ficam de fora e são resolvidos do node_modules da raiz.
export const EXTERNAL_MODULES = ['node-pty', 'pino', 'pino-roll', '@xterm/headless', '@xterm/addon-serialize', 'zod'];

export async function buildHost(): Promise<string> {
  await build({
    entryPoints: [join(here, 'src', 'main.ts')],
    outfile: HOST_SCRIPT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: EXTERNAL_MODULES,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  return HOST_SCRIPT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildHost();
