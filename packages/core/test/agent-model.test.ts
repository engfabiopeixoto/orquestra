import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeProjectDirName, findClaudeTranscript, readClaudeModel, readCodexModel } from '../src/agent-model.js';
import { findCodexRollout } from '../src/codex-rollout-watcher.js';

const fixture = (path: string) => fileURLToPath(new URL(`./fixtures/models/${path}`, import.meta.url));

describe('modelo efetivo do Claude (transcrição)', () => {
  it('vem da última resposta do agente principal; ignora subagente e resposta sintética', async () => {
    expect(await readClaudeModel(fixture('claude-session.jsonl'))).toEqual({ model: 'claude-sonnet-5-5', at: Date.parse('2026-10-08T10:02:05.000Z') });
  });

  it('sem resposta ou sem arquivo, não há modelo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-model-'));
    const empty = join(dir, 'vazia.jsonl');
    writeFileSync(empty, '{"type":"user","message":{"role":"user","content":"oi"}}\n');
    expect(await readClaudeModel(empty)).toBeNull();
    expect(await readClaudeModel(join(dir, 'nao-existe.jsonl'))).toBeNull();
  });

  it('acha a transcrição pela pasta do projeto ou procurando a sessão nas outras pastas', () => {
    const claudeDir = mkdtempSync(join(tmpdir(), 'orq-claude-'));
    const id = '11111111-1111-4111-8111-111111111111';
    expect(claudeProjectDirName('E:\\Projetos claude\\orquestra')).toBe('E--Projetos-claude-orquestra');
    const direct = join(claudeDir, 'projects', claudeProjectDirName('C:\\work\\a'));
    mkdirSync(direct, { recursive: true });
    copyFileSync(fixture('claude-session.jsonl'), join(direct, `${id}.jsonl`));
    expect(findClaudeTranscript(claudeDir, 'C:\\work\\a', id)).toBe(join(direct, `${id}.jsonl`));
    // O cwd mudou (pasta editada): a sessão continua na pasta antiga.
    expect(findClaudeTranscript(claudeDir, 'C:\\outra', id)).toBe(join(direct, `${id}.jsonl`));
    expect(findClaudeTranscript(claudeDir, 'C:\\work\\a', 'outra-sessao')).toBeNull();
  });
});

describe('modelo efetivo do Codex (rollout)', () => {
  it('vem do turn_context do último turno', async () => {
    expect(await readCodexModel(fixture('codex-rollout.jsonl'))).toEqual({ model: 'gpt-6-luna', at: Date.parse('2026-10-08T10:05:01.000Z') });
  });

  it('lê só o fim de um rollout longo', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'orq-model-')), 'longo.jsonl');
    const filler = `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(1000) } })}\n`;
    writeFileSync(path, `${JSON.stringify({ timestamp: '2026-10-08T09:00:00.000Z', type: 'turn_context', payload: { model: 'antigo' } })}\n${filler.repeat(600)}${JSON.stringify({ timestamp: '2026-10-08T10:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } })}\n`);
    expect(await readCodexModel(path)).toMatchObject({ model: 'gpt-6.1-sol' });
  });

  it('acha o rollout da thread nas pastas por data', () => {
    const home = mkdtempSync(join(tmpdir(), 'orq-codex-'));
    const id = '22222222-2222-4222-8222-222222222222';
    const day = join(home, 'sessions', '2026', '10', '08');
    mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-2026-10-08T10-00-00-${id}.jsonl`);
    copyFileSync(fixture('codex-rollout.jsonl'), path);
    expect(findCodexRollout(id, home)).toBe(path);
    expect(findCodexRollout('outra', home)).toBeNull();
  });
});
