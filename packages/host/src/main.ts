import { agyAdapter, claudeAdapter, codexAdapter, shellAdapter, readAgyUsage } from '@orquestra/core';
import { runHost } from './run.js';

if (process.argv[2] === '--usage-agy') {
  try { process.stdout.write(JSON.stringify({ ok: true, usage: await readAgyUsage(process.argv[3]!) })); }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Uso indisponível.' })); }
  process.exit(0);
} else {
  await runHost({ adapters: { claude: claudeAdapter, agy: agyAdapter, codex: codexAdapter, shell: shellAdapter } });
}
