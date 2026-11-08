import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeProjectDirName, findClaudeTranscript, modelFromArgs, readAgySettingsModel, readClaudeModel, readCodexConfigModel, readCodexModel, startupModel } from '../src/agent-model.js';
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

describe('modelo no início, antes do primeiro turno', () => {
  const codexHome = (toml: string) => {
    const home = mkdtempSync(join(tmpdir(), 'orq-codex-'));
    writeFileSync(join(home, 'config.toml'), toml);
    return home;
  };
  const agySettings = (json: unknown) => {
    const file = join(mkdtempSync(join(tmpdir(), 'orq-agy-')), 'settings.json');
    writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
    return file;
  };

  it('codex: model do config.toml, do perfil ativo ou do perfil pedido nos argumentos', () => {
    const toml = ['model = "gpt-6.1-sol" # padrão', 'model_reasoning_effort = "medium"', '', '[profiles.rapido]', "model = 'gpt-6-luna'", '', '[tui.model_availability_nux]', '"gpt-6.1-sol" = 4', ''].join('\r\n');
    expect(readCodexConfigModel(codexHome(toml))).toBe('gpt-6.1-sol');
    expect(readCodexConfigModel(codexHome(toml), 'rapido')).toBe('gpt-6-luna');
    expect(readCodexConfigModel(codexHome(`profile = "rapido"\n${toml}`))).toBe('gpt-6-luna');
    expect(readCodexConfigModel(codexHome('[tui]\nmodel = "nao-e-o-topo"\n'))).toBeNull();
    expect(readCodexConfigModel(mkdtempSync(join(tmpdir(), 'orq-codex-vazio-')))).toBeNull();
  });

  it('agy: settings.json guarda o nome de exibição; vira o id da lista', () => {
    expect(readAgySettingsModel(agySettings({ model: 'Gemini 3.8 Flash (Medium)', permissions: {} }))).toBe('gemini-3.8-flash-medium');
    expect(readAgySettingsModel(agySettings({ permissions: {} }))).toBeNull();
    expect(readAgySettingsModel(agySettings('{ quebrado'))).toBeNull();
  });

  it('argumentos extras: --model, -m, --model=, -c model= e --profile', () => {
    expect(modelFromArgs('codex', ['-m', 'gpt-6-sol'])).toEqual({ model: 'gpt-6-sol', profile: null });
    expect(modelFromArgs('codex', ['-c', 'model="gpt-6-astra"', '--profile', 'rapido'])).toEqual({ model: 'gpt-6-astra', profile: 'rapido' });
    expect(modelFromArgs('agy', ['--model=gemini-4-argon-high', '--mode', 'plan'])).toEqual({ model: 'gemini-4-argon-high', profile: null });
    expect(modelFromArgs('agy', ['--mode', 'plan'])).toEqual({ model: null, profile: null });
  });

  it('a flag vence o padrão do CLI e os argumentos extras vencem a flag da tag', () => {
    const home = codexHome('model = "gpt-6.1-sol"\n');
    const settings = agySettings({ model: 'Gemini 3.8 Flash (Medium)' });
    expect(startupModel('codex', { chosen: null, args: [], codexHome: home })).toBe('gpt-6.1-sol');
    expect(startupModel('codex', { chosen: 'gpt-6-luna', args: [], codexHome: home })).toBe('gpt-6-luna');
    expect(startupModel('codex', { chosen: 'gpt-6-luna', args: ['-m', 'gpt-6-sol'], codexHome: home })).toBe('gpt-6-sol');
    expect(startupModel('agy', { chosen: null, args: [], agySettingsFile: settings })).toBe('gemini-3.8-flash-medium');
    expect(startupModel('agy', { chosen: 'gemini-3.8-flash-low', args: [], agySettingsFile: settings })).toBe('gemini-3.8-flash-low');
    // O Claude informa o modelo no SessionStart.
    expect(startupModel('claude', { chosen: 'opus', args: [] })).toBeNull();
  });
});
