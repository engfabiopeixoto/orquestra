import { build } from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
export const CLI_SCRIPT = join(here, 'dist', 'orq.mjs');

export async function buildCli(): Promise<string> {
  await build({
    entryPoints: [join(here, 'src', 'bin.ts')],
    outfile: CLI_SCRIPT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
  });
  return CLI_SCRIPT;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildCli();
