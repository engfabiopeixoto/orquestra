import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeDriver, claudeHookSettings } from '../src/drivers/claude.js';
import type { HookEnvelope } from '../src/types.js';

const envelope = (event: string, payload: unknown): HookEnvelope => ({ agent: 'claude', event, payload, receivedAt: 0 });

const fixture = (name: string): HookEnvelope =>
  JSON.parse(readFileSync(new URL(`../fixtures/claude/${name}`, import.meta.url), 'utf8'));

describe('claudeDriver contra payloads reais', () => {
  it('interpreta o Stop real com texto', () => {
    const signal = claudeDriver.interpret(fixture('stop.json'));
    expect(signal.kind).toBe('turn-end');
    if (signal.kind === 'turn-end') expect(signal.text ?? signal.transcriptPath).toBeTruthy();
  });

  it('interpreta o SessionStart real', () => {
    expect(claudeDriver.interpret(fixture('session-start.json'))).toMatchObject({ kind: 'session-start' });
  });

  it.runIf(existsSync(new URL('../fixtures/claude/notification.json', import.meta.url)))('interpreta a Notification real', () => {
    expect(claudeDriver.interpret(fixture('notification.json')).kind).toBe('waiting-user');
  });
});

describe('claudeHookSettings', () => {
  it('registra Stop, Notification e SessionStart apontando para o relay com aspas', () => {
    const settings = claudeHookSettings() as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'SessionStart', 'Stop']);
    const command = settings.hooks.Stop![0]!.hooks[0]!.command;
    expect(command).toMatch(/^node ".+hook-relay\.mjs" claude Stop$/);
    expect(command).not.toContain('\\');
  });
});

describe('claudeDriver.interpret', () => {
  it('Stop com last_assistant_message vira turn-end com texto', () => {
    const signal = claudeDriver.interpret(
      envelope('Stop', { session_id: 's1', transcript_path: 'C:/t.jsonl', last_assistant_message: '391' }),
    );
    expect(signal).toEqual({ kind: 'turn-end', text: '391', transcriptPath: 'C:/t.jsonl', sessionId: 's1' });
  });

  it('Stop sem last_assistant_message devolve texto nulo e o caminho da transcrição', () => {
    const signal = claudeDriver.interpret(envelope('Stop', { session_id: 's1', transcript_path: 'C:/t.jsonl' }));
    expect(signal).toMatchObject({ kind: 'turn-end', text: null, transcriptPath: 'C:/t.jsonl' });
  });

  it('Notification de permissão vira waiting-user', () => {
    const signal = claudeDriver.interpret(
      envelope('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }),
    );
    expect(signal).toEqual({ kind: 'waiting-user', detail: 'Claude needs your permission' });
  });

  it('SessionStart devolve o id de sessão', () => {
    expect(claudeDriver.interpret(envelope('SessionStart', { session_id: 's9', source: 'startup' }))).toEqual({
      kind: 'session-start',
      sessionId: 's9',
    });
  });

  it('payload inesperado é ignorado sem lançar erro', () => {
    expect(claudeDriver.interpret(envelope('Stop', 'texto'))).toEqual({ kind: 'ignored' });
  });
});
