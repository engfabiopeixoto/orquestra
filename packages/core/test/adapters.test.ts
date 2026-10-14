import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agyAdapter, agyHookGroup, isUnsafeForAgy, readAgyTranscript } from '../src/adapters/agy.js';
import { claudeAdapter, claudeHookSettings } from '../src/adapters/claude.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { readClaudeTranscript } from '../src/adapters/claude-transcript.js';
import { shellAdapter } from '../src/adapters/shell.js';

const fixture = (path: string) => fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url));
const envelopePayload = (path: string) => (JSON.parse(readFileSync(fixture(path), 'utf8')) as { payload: unknown }).payload;
const hook = (event: string) => `node C:/orq/bin/orq.mjs hook x ${event}`;

function jsonl(lines: unknown[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'orq-tr-')), 't.jsonl');
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n'));
  return path;
}

describe('claudeAdapter', () => {
  it('registra início, retomada e falha; subagentes não terminam o turno principal', () => {
    const settings = claudeHookSettings(hook) as { hooks: Record<string, unknown> };
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'StopFailure']) expect(settings.hooks[event]).toBeDefined();
    expect(claudeAdapter.interpretHook('StopFailure', { error: 'rate_limit' })).toEqual({ kind: 'turn-failed' });
    expect(claudeAdapter.interpretHook('SubagentStop', { agent_id: 'sub' })).toEqual({ kind: 'ignored' });
    expect(claudeAdapter.interpretHook('PostToolUse', { agent_id: 'sub' })).toEqual({ kind: 'ignored' });
    expect(claudeAdapter.interpretHook('Notification', { notification_type: 'idle_prompt' })).toEqual({ kind: 'ignored' });
  });
  it('reconhece limite de uso e erro de API como falha do agente', () => {
    const signals = (text: string) => claudeAdapter.screenRules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.signal);
    expect(signals("You've hit your session limit · resets 10:20am (America/Sao_Paulo)")).toEqual(['failed']);
    expect(signals('API Error: 529 {"type":"overloaded_error"}')).toEqual(['failed']);
    expect(signals('A API do Claude é ótima')).toEqual([]);
  });

  it('lança com --settings apontando para os hooks da sessão', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'orq-s-'));
    const spec = claudeAdapter.launch({ cwd: sessionDir, sessionDir, hookCommand: hook, resumeSessionId: null });
    expect(spec.command).toBe('claude');
    expect(spec.args[0]).toBe('--settings');
    expect(JSON.parse(readFileSync(spec.args[1]!, 'utf8'))).toEqual(claudeHookSettings(hook));
  });

  it('interpreta o Stop real com o texto da resposta', () => {
    const signal = claudeAdapter.interpretHook('Stop', envelopePayload('claude/stop.json'));
    expect(signal).toMatchObject({ kind: 'turn-end' });
    if (signal.kind === 'turn-end') expect(signal.text).toBeTruthy();
  });

  it('reconhece a interrupção na tela com o texto real do Claude Code', () => {
    const line = '  ⎿  Interrupted · What should Claude do instead?';
    expect(claudeAdapter.screenRules.filter((rule) => rule.pattern.test(line)).map((rule) => rule.signal)).toEqual(['interrupted']);
  });

  it('Notification vira espera do usuário e payload estranho é ignorado', () => {
    expect(claudeAdapter.interpretHook('Notification', { message: 'precisa de permissão' })).toEqual({
      kind: 'waiting',
      detail: 'precisa de permissão',
    });
    expect(claudeAdapter.interpretHook('Stop', 'texto')).toEqual({ kind: 'ignored' });
  });
});

describe('readClaudeTranscript', () => {
  it('lê a resposta da transcrição real', async () => {
    expect(await readClaudeTranscript(fixture('claude/transcript.jsonl'))).toBe('81');
  });

  it('não devolve resposta de turno anterior nem texto que acompanha tool_use', async () => {
    const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
    const assistant = (content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', content } });
    expect(await readClaudeTranscript(jsonl([user('p1'), assistant([{ type: 'text', text: 'r1' }]), user('p2')]))).toBeNull();
    const intermediate = assistant([{ type: 'text', text: 'vou ler' }, { type: 'tool_use', name: 'Read' }]);
    const toolResult = user([{ type: 'tool_result', content: 'x' }]);
    expect(await readClaudeTranscript(jsonl([user('p'), intermediate, toolResult]))).toBeNull();
    expect(await readClaudeTranscript(jsonl([user('p'), intermediate, toolResult, assistant([{ type: 'text', text: 'fim' }])]))).toBe('fim');
  });
});

describe('agyAdapter', () => {
  it('o Stop real vira fim de turno sem texto, com a transcrição', () => {
    expect(agyAdapter.interpretHook('Stop', envelopePayload('agy/stop.json'))).toMatchObject({ kind: 'turn-end', text: null });
  });

  it('o grupo de hooks usa Stop plano, sem matcher', () => {
    expect(agyHookGroup('node C:/b/orq.mjs hook agy Stop')).toEqual({
      Stop: [{ type: 'command', command: 'node C:/b/orq.mjs hook agy Stop', timeout: 10 }],
    });
  });

  it('marca como inseguros os símbolos que o agy descarta e aceita acentos', () => {
    expect(['×', '✅', '“', '—', '±'].every(isUnsafeForAgy)).toBe(true);
    expect(['a', 'ç', 'ã', 'é', '°', 'ª', '?', '\n'].some(isUnsafeForAgy)).toBe(false);
  });

  it('prompt com símbolos vai para um arquivo dentro da pasta do projeto', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orq-agy-'));
    const prepared = agyAdapter.preparePrompt('quanto é 2 × 3?', { cwd, askId: 'a1' });
    const file = join(cwd, '.orquestra', 'prompts', 'a1.md');
    expect(readFileSync(file, 'utf8')).toBe('quanto é 2 × 3?');
    expect(prepared).toContain(file.replaceAll('\\', '/'));
    expect(readFileSync(join(cwd, '.orquestra', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('prompt só com letras e acentos vai direto', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'orq-agy-'));
    expect(agyAdapter.preparePrompt('olá, ação', { cwd, askId: 'a2' })).toBe('olá, ação');
    expect(existsSync(join(cwd, '.orquestra'))).toBe(false);
  });

  it('reconhece permissão e interrupção na tela', () => {
    const match = (text: string) => agyAdapter.screenRules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.signal);
    expect(match('Requesting permission for:\n   Get-ChildItem')).toEqual(['waiting']);
    expect(match('⎿  Interrupted · What should Antigravity CLI do instead?')).toEqual(['interrupted']);
  });
});

describe('codexAdapter', () => {
  const signals = (text: string) => codexAdapter.screenRules.filter((rule) => rule.pattern.test(text)).map((rule) => rule.signal);

  it('usa a tela apenas para diálogos de espera, incluindo Hooks need review com linhas vazias', () => {
    const hooksDialog = [
      'Hooks need review', '', '2 hooks are new or changed.', '',
      '1. Review hooks', '', '2. Trust all and continue', '', '3. Continue without trusting (hooks won\'t run)',
    ].join('\n');
    expect(signals(hooksDialog)).toEqual(['waiting']);
    expect(signals('  Trust this folder? Codex can read, edit, and run files here, subject to your')).toEqual(['waiting']);
    expect(signals('  Worked for 1m 21s • 17:19')).toEqual([]);
    expect(signals('■ Conversation interrupted - use /feedback if something went wrong')).toEqual([]);
  });
});

describe('readAgyTranscript', () => {
  const user = (step: number) => ({ step_index: step, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'x' });
  const model = (step: number, content: string, extra: object = {}) => ({ step_index: step, source: 'MODEL', type: 'PLANNER_RESPONSE', content, ...extra });

  it('lê a resposta da transcrição real', async () => {
    expect(await readAgyTranscript(fixture('agy/transcript_full.jsonl'))).toBe('TANGERINA-42');
  });

  it('só aceita resposta final depois do último prompt', async () => {
    expect(await readAgyTranscript(jsonl([user(1), model(2, 'antiga'), user(3)]))).toBeNull();
    expect(await readAgyTranscript(jsonl([user(1), model(2, 'vou listar', { tool_calls: [{}] })]))).toBeNull();
    expect(await readAgyTranscript(jsonl([user(1), model(2, ''), model(3, 'final')]))).toBe('final');
  });
});

describe('shellAdapter', () => {
  it('não recebe prompts', () => {
    expect(shellAdapter.acceptsPrompts).toBe(false);
  });
});

describe('retomada no lançamento', () => {
  const ctx = (resumeSessionId: string | null) => ({
    cwd: tmpdir(),
    sessionDir: mkdtempSync(join(tmpdir(), 'orq-launch-')),
    hookCommand: (event: string) => `node orq.mjs hook claude ${event}`,
    resumeSessionId,
  });

  it('claude nasce com um --session-id novo e informa o id', () => {
    const spec = claudeAdapter.launch(ctx(null));
    const index = spec.args.indexOf('--session-id');
    expect(index).toBeGreaterThan(-1);
    expect(spec.args[index + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(spec.agentSessionId).toBe(spec.args[index + 1]);
  });

  it('claude retoma com --resume e mantém o id', () => {
    const spec = claudeAdapter.launch(ctx('5f0c1d2e-0000-4000-8000-000000000001'));
    expect(spec.args.slice(-2)).toEqual(['--resume', '5f0c1d2e-0000-4000-8000-000000000001']);
    expect(spec.args).not.toContain('--session-id');
    expect(spec.agentSessionId).toBe('5f0c1d2e-0000-4000-8000-000000000001');
  });

  it('agy retoma com --conversation; sem id, lança sem argumentos', () => {
    expect(agyAdapter.launch(ctx('conv-1')).args).toEqual(['--conversation', 'conv-1']);
    expect(agyAdapter.launch(ctx(null)).args).toEqual([]);
  });
});
