import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeStatusWatcher, readClaudeSessionStatus } from '../src/adapters/claude-status.js';
import { readClaudeTranscript } from '../src/adapters/claude-transcript.js';
import { silentLogger } from '../src/log.js';
import { waitFor } from './helpers/wait.js';

const dirs: string[] = [];
const sessionsDir = () => { const dir = mkdtempSync(join(tmpdir(), 'orq-sessions-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Arquivo real de ~/.claude/sessions/<pid>.json (Claude Code 2.1.300), com caminhos e nomes de teste.
const realFile = {
  pid: 24188,
  sessionId: 'fa074cce-7d86-4ac6-a126-f21d6319d70e',
  cwd: 'C:\\Users\\USER\\AppData\\Local\\Temp\\orq-e2e-proj-439xax',
  startedAt: 1792018175995,
  procStart: '134364917731908093',
  version: '2.1.300',
  peerProtocol: 1,
  peerFeatures: ['notify_idle', 'artifact_yield'],
  kind: 'interactive',
  entrypoint: 'cli',
  name: 'orq-e2e-proj-439xax-a5',
  nameSource: 'derived',
  status: 'idle',
  updatedAt: 1792018180495,
  statusUpdatedAt: 1792018180495,
};
const write = (dir: string, name: string, content: unknown) => writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));

describe('readClaudeSessionStatus', () => {
  it('lê o status pelo pid do terminal', () => {
    const dir = sessionsDir();
    write(dir, '24188.json', realFile);
    expect(readClaudeSessionStatus(dir, { pid: 24188 })).toEqual({ status: 'idle', sessionId: realFile.sessionId, pid: 24188, statusUpdatedAt: realFile.statusUpdatedAt });
  });

  it('lê pelo sessionId quando o pid do terminal não é o do claude', () => {
    const dir = sessionsDir();
    write(dir, '555.json', { ...realFile, pid: 555, sessionId: 'outra-sessao', status: 'busy' });
    write(dir, '24188.json', { ...realFile, status: 'busy' });
    expect(readClaudeSessionStatus(dir, { pid: 1, sessionId: realFile.sessionId })).toMatchObject({ status: 'busy', pid: 24188 });
  });

  it('ignora outras sessões, arquivos .key, JSON inválido, formato inesperado e pasta ausente', () => {
    const dir = sessionsDir();
    write(dir, '1328.c85e1a3d75b7917c.key', { peerToken: 'x' });
    write(dir, '2.json', '{ nao e json');
    write(dir, '3.json', { pid: 3, sessionId: 's3' });
    write(dir, '4.json', { ...realFile, pid: 4, sessionId: 's4', status: 'busy' });
    expect(readClaudeSessionStatus(dir, { pid: 24188, sessionId: realFile.sessionId })).toBeNull();
    expect(readClaudeSessionStatus(join(dir, 'nao-existe'), { pid: 24188 })).toBeNull();
    expect(readClaudeSessionStatus(dir, {})).toBeNull();
  });
});

describe('transcript do Esc antes do primeiro token (Claude Code 2.1.300)', () => {
  it('não traz marcador de interrupção nem resposta: por isso o transcript não pode ser a fonte', async () => {
    const dir = sessionsDir();
    // Trecho real: a mensagem do usuário e os registros de controle que o claude grava em seguida.
    const lines = [
      { type: 'last-prompt', sessionId: realFile.sessionId },
      { type: 'user', message: { role: 'user', content: 'ESC-250: nao use ferramentas; escreva um texto de 1500 palavras sobre o relogio atomico.' }, uuid: '04fc68e4' },
      { type: 'attachment', attachment: { type: 'date', date: '2026-10-14' } },
      { type: 'api-request' },
      { type: 'last-prompt', lastPrompt: 'ESC-250: nao use ferramentas...', sessionId: realFile.sessionId },
      { type: 'mode', mode: 'normal', sessionId: realFile.sessionId },
      { type: 'ai-title', aiTitle: 'ESC-250 relógio atômico', sessionId: realFile.sessionId },
    ];
    const path = join(dir, 'sessao.jsonl');
    write(dir, 'sessao.jsonl', lines.map((line) => JSON.stringify(line)).join('\n'));
    await expect(readClaudeTranscript(path)).resolves.toBeNull();
  });
});

describe('ClaudeStatusWatcher', () => {
  const start = (dir: string, events: string[]) => {
    const watcher = new ClaudeStatusWatcher({
      sessionsDir: dir,
      who: () => ({ pid: realFile.pid }),
      log: silentLogger(),
      pollMs: 20,
      onBusy: () => events.push('busy'),
      onIdle: () => events.push('idle'),
    });
    watcher.start();
    return watcher;
  };

  it('só avisa ocioso depois de ter visto ocupado (o claude demora a sair de idle ao receber o prompt)', async () => {
    const dir = sessionsDir();
    write(dir, '24188.json', realFile);
    const events: string[] = [];
    const watcher = start(dir, events);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(events).toEqual([]);
      write(dir, '24188.json', { ...realFile, status: 'busy' });
      await waitFor(() => events.includes('busy'));
      write(dir, '24188.json', { ...realFile, status: 'idle' });
      await waitFor(() => events.includes('idle'));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(events.filter((event) => event === 'idle')).toHaveLength(1);
    } finally { watcher.stop(); }
  });

  it('idle mais novo que o início do turno prova que houve busy, mesmo sem ter amostrado o busy (Esc rápido)', async () => {
    const dir = sessionsDir();
    // O busy durou menos que o intervalo de leitura: o arquivo já voltou a idle quando o watcher lê.
    write(dir, '24188.json', { ...realFile, status: 'idle', statusUpdatedAt: Date.now() + 60_000 });
    const events: string[] = [];
    const watcher = start(dir, events);
    try {
      await waitFor(() => events.includes('idle'));
      expect(events).not.toContain('busy');
    } finally { watcher.stop(); }
  });

  it('idle antigo (anterior ao turno) não conta, nem depois de várias leituras', async () => {
    const dir = sessionsDir();
    write(dir, '24188.json', { ...realFile, status: 'idle', statusUpdatedAt: Date.now() - 60_000 });
    const events: string[] = [];
    const watcher = start(dir, events);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(events).toEqual([]);
    } finally { watcher.stop(); }
  });

  it('qualquer status diferente de idle conta como agente ativo e para de ler depois de stop()', async () => {
    const dir = sessionsDir();
    write(dir, '24188.json', { ...realFile, status: 'waiting' });
    const events: string[] = [];
    const watcher = start(dir, events);
    await waitFor(() => events.includes('busy'));
    watcher.stop();
    const count = events.length;
    write(dir, '24188.json', { ...realFile, status: 'idle' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toHaveLength(count);
  });

  it('não lê o arquivo antes do start()', () => {
    const onIdle = vi.fn();
    const watcher = new ClaudeStatusWatcher({ sessionsDir: sessionsDir(), who: () => ({ pid: 1 }), log: silentLogger(), pollMs: 10, onBusy: () => {}, onIdle });
    expect(watcher.running).toBe(false);
  });
});
