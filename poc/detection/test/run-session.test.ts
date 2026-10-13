import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeDriver } from '../src/drivers/fake.js';
import { childEnv, RUNS_ROOT, runSession, WORK_ROOT } from '../src/run-session.js';
import { SCENARIOS } from '../src/scenarios.js';
import type { AgentDriver } from '../src/types.js';

const aritmetica = SCENARIOS.filter((item) => item.id === 'aritmetica');
const fastTimings = { readyQuietMs: 300, heuristicQuietMs: 300, turnTimeoutMs: 10_000 };

describe('childEnv', () => {
  it('remove marcas de sessão do agente herdadas do processo pai', () => {
    const env = childEnv({
      PATH: 'C:/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(env).toEqual({ PATH: 'C:/bin', ANTHROPIC_API_KEY: 'k' });
  });

  it('mantém configurações do Claude Code que o usuário define de propósito', () => {
    const env = childEnv({ CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bin/bash.exe', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: 'C:/c' });
    expect(env).toEqual({ CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bin/bash.exe', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: 'C:/c' });
  });
});

describe('runSession com o agente falso', () => {
  it('injeta o prompt, recebe o Stop e grava o resultado', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'orq run '));
    const results = await runSession({ driver: fakeDriver, scenarios: aritmetica, runDir, attach: false, ...fastTimings });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ scenarioId: 'aritmetica', correct: true, clean: true, source: 'hook' });
    expect(results[0]!.heuristicAnswer).toContain('391');
    expect(readFileSync(join(runDir, 'results.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readdirSync(join(runDir, 'envelopes')).length).toBeGreaterThanOrEqual(1);
  });

  it('a pasta de trabalho do agente fica fora da pasta de resultados', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'orq run '));
    await runSession({ driver: fakeDriver, scenarios: aritmetica, runDir, attach: false, ...fastTimings });
    expect(existsSync(join(runDir, 'work'))).toBe(false);
    expect(existsSync(join(WORK_ROOT, basename(runDir), 'work'))).toBe(true);
    expect(WORK_ROOT.startsWith(RUNS_ROOT)).toBe(false);
  });

  it('aprova a permissão só nos cenários que permitem ferramentas e nega nos demais', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'orq run '));
    const askingDriver: AgentDriver = {
      ...fakeDriver,
      launch: (ctx) => {
        const spec = fakeDriver.launch(ctx);
        return { ...spec, env: { ...spec.env, FAKE_ASK_PERMISSION: '1' } };
      },
      autoAnswers: [
        { whenScreen: /Permitir este comando\?/, keys: ['s'], onlyWhen: (scenario) => scenario?.allowTools === true },
        { whenScreen: /Permitir este comando\?/, keys: ['\x1b'], onlyWhen: (scenario) => scenario?.allowTools !== true },
      ],
    };
    const comFerramenta = { id: 'com', prompt: 'usa ferramenta', check: () => true, allowTools: true };
    const semFerramenta = { id: 'sem', prompt: 'só responde', check: () => true };
    const results = await runSession({
      driver: askingDriver,
      scenarios: [comFerramenta, semFerramenta],
      runDir,
      attach: false,
      ...fastTimings,
    });
    expect(results.map((item) => [item.scenarioId, item.answer])).toEqual([
      ['com', 'permitido'],
      ['sem', 'negado'],
    ]);
  });

  it('ignora Stop sem prompt em curso', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'orq run '));
    const noisyDriver: AgentDriver = {
      ...fakeDriver,
      launch: (ctx) => {
        const spec = fakeDriver.launch(ctx);
        return { ...spec, env: { ...spec.env, FAKE_STRAY_STOP: '1' } };
      },
    };
    const twice = [...aritmetica, { ...aritmetica[0]!, id: 'aritmetica-2' }];
    const results = await runSession({ driver: noisyDriver, scenarios: twice, runDir, attach: false, ...fastTimings });
    expect(results.map((item) => item.scenarioId)).toEqual(['aritmetica', 'aritmetica-2']);
    expect(results.every((item) => item.correct && item.answer === '391')).toBe(true);
    const envelopes = readdirSync(join(runDir, 'envelopes'));
    expect(envelopes.length).toBe(3);
  });

  it('responde automaticamente a um diálogo na tela antes de injetar o prompt', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'orq run '));
    const askingDriver: AgentDriver = {
      ...fakeDriver,
      launch: (ctx) => {
        const spec = fakeDriver.launch(ctx);
        return { ...spec, env: { ...spec.env, FAKE_ASK_TRUST: '1' } };
      },
    };
    const results = await runSession({
      driver: askingDriver,
      scenarios: aritmetica,
      runDir,
      attach: false,
      ...fastTimings,
      autoAnswers: [{ whenScreen: /Confiar nesta pasta\?/, keys: ['s'] }],
    });
    expect(results[0]).toMatchObject({ correct: true, answer: '391' });
  });

  it('depois de um prazo esgotado, espera o Stop atrasado antes de injetar o próximo prompt', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'orq run '));
    const slowDriver: AgentDriver = {
      ...fakeDriver,
      launch: (ctx) => {
        const spec = fakeDriver.launch(ctx);
        return { ...spec, env: { ...spec.env, FAKE_FIRST_DELAY_MS: '2500' } };
      },
    };
    const lento = { ...aritmetica[0]!, id: 'lento', prompt: 'primeiro', check: () => true };
    const results = await runSession({
      driver: slowDriver,
      scenarios: [lento, ...aritmetica],
      runDir,
      attach: false,
      ...fastTimings,
      turnTimeoutMs: 1000,
    });
    expect(results.map((item) => [item.scenarioId, item.source, item.answer])).toEqual([
      ['lento', 'none', null],
      ['aritmetica', 'hook', '391'],
    ]);
  });

  it('não espera o prazo quando o agente sai no meio do turno', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'orq run '));
    const dyingDriver: AgentDriver = {
      ...fakeDriver,
      launch: (ctx) => {
        const spec = fakeDriver.launch(ctx);
        return { ...spec, env: { ...spec.env, FAKE_EXIT_ON_PROMPT: '1' } };
      },
    };
    const startedAt = Date.now();
    const results = await runSession({ driver: dyingDriver, scenarios: aritmetica, runDir, attach: false, ...fastTimings, turnTimeoutMs: 15_000 });
    expect(results[0]).toMatchObject({ correct: false, source: 'none' });
    expect(Date.now() - startedAt).toBeLessThan(8000);
  });

  it('marca o cenário como falho quando o turno passa do prazo', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'orq run '));
    const silentDriver: AgentDriver = { ...fakeDriver, interpret: () => ({ kind: 'ignored' }) };
    const results = await runSession({
      driver: silentDriver,
      scenarios: aritmetica,
      runDir,
      attach: false,
      ...fastTimings,
      turnTimeoutMs: 1500,
    });
    expect(results[0]).toMatchObject({ correct: false, source: 'none' });
  });
});
