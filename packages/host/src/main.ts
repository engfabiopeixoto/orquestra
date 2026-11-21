import { agyAdapter, claudeAdapter, codexAdapter, measureProject, shellAdapter, readAgyUsage } from '@orquestra/core';
import { runHost } from './run.js';

if (process.argv[2] === '--usage-agy') {
  try { process.stdout.write(JSON.stringify({ ok: true, usage: await readAgyUsage(process.argv[3]!) })); }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Uso indisponível.' })); }
  process.exit(0);
} else if (process.argv[2] === '--quality') {
  try { process.stdout.write(JSON.stringify({ ok: true, report: await measureProject(process.argv[3]!) })); }
  catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Medição de qualidade indisponível.' })); }
  process.exit(0);
} else {
  await runHost({ adapters: { claude: claudeAdapter, agy: agyAdapter, codex: codexAdapter, shell: shellAdapter } });
}
