import { describe, expect, it } from 'vitest';
import { hostEventSchema, terminalInfoSchema } from '../src/host-protocol.js';
import { AGENT_MODELS, agyModelId, isModelAgent, modelCommand, modelNameSchema, sameModel, terminalModel } from '../src/models.js';
import { workspaceTerminalSchema } from '../src/workspace.js';

describe('lista de modelos', () => {
  it('cada agente tem uma lista fixa, sem repetição e com nomes que o CLI aceita', () => {
    for (const agent of ['claude', 'codex', 'agy'] as const) {
      const ids = AGENT_MODELS[agent].map((option) => option.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(modelNameSchema.safeParse(id).success).toBe(true);
    }
    expect(AGENT_MODELS.claude.map((option) => option.id)).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku']));
    expect(AGENT_MODELS.codex.map((option) => option.id)).toContain('gpt-6.1-sol');
    expect(AGENT_MODELS.agy.map((option) => option.id)).toContain('gemini-3.8-flash-medium');
  });

  it('só os agentes têm modelo; o shell não', () => {
    expect(isModelAgent('claude')).toBe(true);
    expect(isModelAgent('shell')).toBe(false);
  });

  it('nome digitado não pode ter espaço nem aspas (vai para o argv e para o terminal)', () => {
    expect(modelNameSchema.parse('  opus[1m] ')).toBe('opus[1m]');
    expect(modelNameSchema.safeParse('gpt 6').success).toBe(false);
    expect(modelNameSchema.safeParse('"opus"').success).toBe(false);
    expect(modelNameSchema.safeParse('').success).toBe(false);
    expect(modelNameSchema.safeParse('opus\r/model x').success).toBe(false);
  });

  it('o comando de troca é o /model do agente com o nome', () => {
    expect(modelCommand('gpt-6-luna')).toBe('/model gpt-6-luna');
  });
});

describe('comparação do modelo', () => {
  it('nome igual, sufixo de data e maiúsculas contam como o mesmo modelo', () => {
    expect(sameModel('codex', 'gpt-6.1-sol', 'gpt-6.1-sol')).toBe(true);
    expect(sameModel('claude', 'claude-haiku-5-5', 'claude-haiku-5-5-20261001')).toBe(true);
    expect(sameModel('agy', 'Gemini-3.8-Flash-High', 'gemini-3.8-flash-high')).toBe(true);
    expect(sameModel('codex', 'gpt-6', 'gpt-6-sol')).toBe(false);
    expect(sameModel('agy', 'gemini-3.8-flash-high', 'gemini-3.8-flash-low')).toBe(false);
  });

  it('alias do Claude corresponde ao id completo da família', () => {
    expect(sameModel('claude', 'opus', 'claude-opus-5-5')).toBe(true);
    expect(sameModel('claude', 'opus[1m]', 'claude-opus-5-5')).toBe(true);
    expect(sameModel('claude', 'sonnet', 'claude-opus-5-5')).toBe(false);
    expect(sameModel('claude', 'opusplan', 'claude-sonnet-5-5')).toBe(true);
    // Alias só vale para o Claude: no agy o nome é o id exato.
    expect(sameModel('agy', 'opus', 'claude-opus-5-5-high')).toBe(false);
  });

  it('agy: nome de exibição (settings do agy) e id (hook e flag) são o mesmo modelo', () => {
    expect(agyModelId('Gemini 3.8 Flash (Medium)')).toBe('gemini-3.8-flash-medium');
    expect(agyModelId('Claude Opus 5.5 (High)')).toBe('claude-opus-5-5-high');
    expect(agyModelId('Modelo Novo (Low)')).toBe('Modelo Novo (Low)');
    expect(sameModel('agy', 'gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)')).toBe(true);
    expect(sameModel('agy', 'gemini-5-flash-low', 'Gemini 5 Flash (Low)')).toBe(true);
    expect(sameModel('agy', 'gemini-3.8-flash-high', 'Gemini 3.8 Flash (Medium)')).toBe(false);
  });

  it('estado da tag: sem escolha, sem informação, pendente, confirmado e divergente', () => {
    const chosenAt = 1_000;
    expect(terminalModel('claude', null, chosenAt, { model: 'claude-opus-5-5', at: 2_000 })).toEqual({ chosen: null, effective: 'claude-opus-5-5', status: 'unset' });
    expect(terminalModel('claude', 'opus', chosenAt, null)).toEqual({ chosen: 'opus', effective: null, status: 'unknown' });
    expect(terminalModel('claude', 'opus', chosenAt, { model: 'claude-sonnet-5-5', at: 500 })).toEqual({ chosen: 'opus', effective: 'claude-sonnet-5-5', status: 'pending' });
    expect(terminalModel('claude', 'opus', chosenAt, { model: 'claude-opus-5-5', at: 1_500 })).toMatchObject({ status: 'match' });
    expect(terminalModel('codex', 'gpt-6.1-sol', chosenAt, { model: 'gpt-6-luna', at: 1_500 })).toEqual({ chosen: 'gpt-6.1-sol', effective: 'gpt-6-luna', status: 'mismatch' });
  });
});

describe('contrato', () => {
  const terminal = { id: '7c0c5f7e-8f6c-4a52-9a3b-0d8f0a1b2c3d', name: 'A', agent: 'claude', cwd: 'C:/p', args: [], resume: true, agentSessionId: null, position: { x: 0, y: 0 }, size: { width: 640, height: 400 } };

  it('o workspace guarda o modelo escolhido e aceita terminais antigos sem ele', () => {
    expect(workspaceTerminalSchema.parse({ ...terminal, model: 'opus' }).model).toBe('opus');
    expect(workspaceTerminalSchema.parse(terminal).model).toBeUndefined();
    expect(workspaceTerminalSchema.parse({ ...terminal, model: null }).model).toBeNull();
    expect(workspaceTerminalSchema.safeParse({ ...terminal, model: 'opus 5' }).success).toBe(false);
  });

  it('terminal e evento levam o modelo escolhido, o efetivo e o estado', () => {
    const model = { chosen: 'opus', effective: 'claude-sonnet-5-5', status: 'mismatch' as const };
    const info = { name: 'A', agent: 'claude', state: 'idle', queued: 0, cwd: 'C:/p', resume: true, args: [], regente: false, monitor: true, model };
    expect(terminalInfoSchema.parse(info).model).toEqual(model);
    expect(hostEventSchema.parse({ type: 'terminal.model', name: 'A', model })).toMatchObject({ type: 'terminal.model', model });
    expect(hostEventSchema.safeParse({ type: 'terminal.model', name: 'A', model: { ...model, status: 'vermelho' } }).success).toBe(false);
  });
});
