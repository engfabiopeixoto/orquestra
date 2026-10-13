// Rodada sem teclado: as respostas automáticas do driver tratam confiança na pasta e permissões.
// Uso: npm run probe -- --agent claude|agy [--only id1,id2] [--timeout-ms 300000]
// Foi assim que as rodadas do relatório da fase 0 foram feitas (prazo de 300 s por turno).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RUNS_ROOT, runSession } from './run-session.js';
import { SCENARIOS } from './scenarios.js';
import { summarize } from './report.js';
import type { AgentDriver } from './types.js';

const drivers: Record<string, () => Promise<AgentDriver>> = {
  claude: async () => (await import('./drivers/claude.js')).claudeDriver,
  agy: async () => (await import('./drivers/agy.js')).createAgyDriver(),
};

const { values } = parseArgs({
  options: {
    agent: { type: 'string' },
    only: { type: 'string' },
    'timeout-ms': { type: 'string', default: '300000' },
  },
});

const loadDriver = values.agent ? drivers[values.agent] : undefined;
if (!loadDriver) {
  console.error(`Agente inválido: ${values.agent ?? '(nenhum)'}. Use --agent ${Object.keys(drivers).join('|')}.`);
  process.exit(2);
}

const scenarios = values.only ? SCENARIOS.filter((item) => values.only!.split(',').includes(item.id)) : SCENARIOS;
const runDir = join(RUNS_ROOT, `${values.agent}-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(runDir, { recursive: true });
console.error(`Rodando ${scenarios.length} cenários com ${values.agent}, sem teclado. Saída em ${runDir}.`);

const results = await runSession({
  driver: await loadDriver(),
  scenarios,
  runDir,
  attach: false,
  turnTimeoutMs: Number(values['timeout-ms']),
});
const summary = summarize(results);
console.log(JSON.stringify(summary));
process.exit(summary.total > 0 && summary.hookOk === summary.total ? 0 : 1);
