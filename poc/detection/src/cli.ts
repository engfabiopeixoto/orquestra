import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fakeDriver } from './drivers/fake.js';
import { RUNS_ROOT, runSession } from './run-session.js';
import { SCENARIOS } from './scenarios.js';
import type { AgentDriver } from './types.js';

const drivers: Record<string, () => Promise<AgentDriver>> = {
  fake: async () => fakeDriver,
  claude: async () => (await import('./drivers/claude.js')).claudeDriver,
  agy: async () => (await import('./drivers/agy.js')).createAgyDriver(),
};

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    only: { type: 'string' },
  },
});

const loadDriver = values.agent ? drivers[values.agent] : undefined;
if (!loadDriver) {
  console.error(`Agente inválido: ${values.agent ?? '(nenhum)'}. Use --agent ${Object.keys(drivers).join('|')}.`);
  process.exit(2);
}

const scenarios = values.only ? SCENARIOS.filter((item) => values.only!.split(',').includes(item.id)) : SCENARIOS;
const runDir = join(RUNS_ROOT, `${values.agent}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(runDir, { recursive: true });

console.error(`Rodando ${scenarios.length} cenários com ${values.agent}. Saída em ${runDir}. Ctrl+] aborta.`);
const results = await runSession({ driver: await loadDriver(), scenarios, runDir, attach: true });

const ok = results.filter((item) => item.correct && item.clean).length;
const heuristicOk = results.filter((item) => item.heuristicCorrect).length;
console.error(`\n\nHooks: ${ok}/${results.length} corretas e limpas. Heurística: ${heuristicOk}/${results.length}.`);
for (const item of results.filter((entry) => !(entry.correct && entry.clean))) {
  console.error(`  falhou: ${item.scenarioId} (fonte ${item.source}) → ${JSON.stringify(item.answer)?.slice(0, 120)}`);
}
// O node-pty mantém um handle do ConPTY vivo depois do kill; encerramos explicitamente.
process.exit(ok === results.length ? 0 : 1);
