import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundJobWatcher, backgroundJobNotice, claudeConfigDir, findBackgroundJob, readBackgroundJob, type BackgroundJob } from '../src/background-job.js';
import { silentLogger } from '../src/log.js';
import { waitFor } from './helpers/wait.js';

const SESSION = '793b7407-bcc4-4c5a-ac40-180664d399cd';
// Pipe do pty host que o daemon abre enquanto a conversa em segundo plano está viva.
const LIVE_PIPE = 'cc-daemon-bc8e3d6ca88bafb5-pty-793b7407';
const PIPES = [LIVE_PIPE, 'cc-daemon-bc8e3d6ca88bafb5-pty-7800b8ac', 'outro-pipe'];
const dirs: string[] = [];
const claudeDir = () => { const dir = mkdtempSync(join(tmpdir(), 'orq-claude-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function writeJob(dir: string, state: Record<string, unknown>, id8 = String(state.sessionId ?? SESSION).slice(0, 8)) {
  mkdirSync(join(dir, 'jobs', id8), { recursive: true });
  writeFileSync(join(dir, 'jobs', id8, 'state.json'), JSON.stringify(state));
}

describe('claudeConfigDir', () => {
  it('usa CLAUDE_CONFIG_DIR quando definido e ~/.claude senão', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'D:\\cfg' }, 'C:\\Users\\x')).toBe('D:\\cfg');
    expect(claudeConfigDir({}, 'C:\\Users\\x')).toBe(join('C:\\Users\\x', '.claude'));
  });
});

describe('readBackgroundJob', () => {
  it('reconhece o job do daemon da mesma sessão e devolve id8 e estado', () => {
    const dir = claudeDir();
    writeJob(dir, { backend: 'daemon', state: 'working', sessionId: SESSION });
    expect(readBackgroundJob(dir, SESSION, () => PIPES)).toEqual({ id8: '793b7407', state: 'working' });
  });

  it('ignora job de outra sessão com o mesmo prefixo, de outro backend e job parado', () => {
    const dir = claudeDir();
    writeJob(dir, { backend: 'daemon', state: 'working', sessionId: '793b7407-0000-0000-0000-000000000000' }, '793b7407');
    expect(readBackgroundJob(dir, SESSION, () => PIPES)).toBeNull();
    writeJob(dir, { backend: 'local', state: 'working', sessionId: SESSION });
    expect(readBackgroundJob(dir, SESSION, () => PIPES)).toBeNull();
    writeJob(dir, { backend: 'daemon', state: 'stopped', sessionId: SESSION });
    expect(readBackgroundJob(dir, SESSION, () => PIPES)).toBeNull();
  });

  it('job antigo sem processo vivo não conta: done, mesmo com pipe, e working sem pipe', () => {
    const dir = claudeDir();
    writeJob(dir, { backend: 'daemon', state: 'done', sessionId: SESSION });
    expect(readBackgroundJob(dir, SESSION, () => PIPES)).toBeNull();
    writeJob(dir, { backend: 'daemon', state: 'working', sessionId: SESSION });
    expect(readBackgroundJob(dir, SESSION, () => [])).toBeNull();
    expect(readBackgroundJob(dir, SESSION, () => ['cc-daemon-bc8e3d6ca88bafb5-pty-7800b8ac'])).toBeNull();
    expect(readBackgroundJob(dir, SESSION, () => { throw new Error('sem pipes'); })).toBeNull();
  });

  it('com o pipe vivo, conta qualquer estado exceto done e stopped', () => {
    const dir = claudeDir();
    for (const state of ['working', 'blocked', 'idle', 'running', 'unknown']) {
      writeJob(dir, { backend: 'daemon', state, sessionId: SESSION });
      expect(readBackgroundJob(dir, SESSION, () => PIPES)).toEqual({ id8: '793b7407', state });
    }
    for (const state of ['done', 'stopped']) {
      writeJob(dir, { backend: 'daemon', state, sessionId: SESSION });
      expect(readBackgroundJob(dir, SESSION, () => PIPES)).toBeNull();
    }
  });

  it('trata pasta jobs inexistente, JSON inválido e id curto como sem job', () => {
    const dir = claudeDir();
    expect(readBackgroundJob(dir, SESSION, () => PIPES)).toBeNull();
    mkdirSync(join(dir, 'jobs', '793b7407'), { recursive: true });
    writeFileSync(join(dir, 'jobs', '793b7407', 'state.json'), '{ nao e json');
    expect(readBackgroundJob(dir, SESSION, () => PIPES)).toBeNull();
    expect(readBackgroundJob(dir, 'curto', () => PIPES)).toBeNull();
  });
});

describe('backgroundJobNotice', () => {
  it('traz o id8 real no comando de parada', () => {
    expect(backgroundJobNotice({ id8: '793b7407', state: 'working' })).toBe('Conversa em segundo plano: sem conexão com o Orquestra. Rode `claude stop 793b7407` e reinicie este terminal.');
  });
});

describe('BackgroundJobWatcher', () => {
  let pipes: string[] = [];
  beforeEach(() => { pipes = [LIVE_PIPE]; });
  const start = (dir: string, sessionId: string | null, changes: Array<BackgroundJob | null>) => {
    const watcher = new BackgroundJobWatcher({ claudeDir: dir, sessionId: () => sessionId, log: silentLogger(), pollMs: 30, listPipes: () => pipes, onChange: (job) => changes.push(job) });
    watcher.start();
    return watcher;
  };

  it('avisa quando o job aparece, mesmo com a pasta jobs ainda inexistente, e quando some', async () => {
    const dir = claudeDir();
    const changes: Array<BackgroundJob | null> = [];
    const watcher = start(dir, SESSION, changes);
    try {
      expect(changes).toEqual([]);
      writeJob(dir, { backend: 'daemon', state: 'working', sessionId: SESSION });
      await waitFor(() => changes.length === 1);
      expect(changes[0]).toEqual({ id8: '793b7407', state: 'working' });
      rmSync(join(dir, 'jobs', '793b7407'), { recursive: true });
      await waitFor(() => changes.length === 2);
      expect(changes[1]).toBeNull();
    } finally { watcher.stop(); }
  });

  it('não repete a notificação a cada leitura e limpa quando o job para', async () => {
    const dir = claudeDir();
    writeJob(dir, { backend: 'daemon', state: 'working', sessionId: SESSION });
    const changes: Array<BackgroundJob | null> = [];
    const watcher = start(dir, SESSION, changes);
    try {
      await waitFor(() => changes.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(changes).toHaveLength(1);
      writeJob(dir, { backend: 'daemon', state: 'stopped', sessionId: SESSION });
      await waitFor(() => changes.length === 2);
      expect(changes[1]).toBeNull();
    } finally { watcher.stop(); }
  });

  it('ignora o job de outra sessão e para de ler depois de stop()', async () => {
    const dir = claudeDir();
    const changes: Array<BackgroundJob | null> = [];
    const watcher = start(dir, SESSION, changes);
    writeJob(dir, { backend: 'daemon', state: 'working', sessionId: 'aaaaaaaa-0000-0000-0000-000000000000' });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(changes).toEqual([]);
    watcher.stop();
    writeJob(dir, { backend: 'daemon', state: 'working', sessionId: SESSION });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(changes).toEqual([]);
  });

  it('só avisa quando o pipe do daemon existe e limpa quando ele some (daemon morto)', async () => {
    const dir = claudeDir();
    writeJob(dir, { backend: 'daemon', state: 'working', sessionId: SESSION });
    pipes = [];
    const changes: Array<BackgroundJob | null> = [];
    const watcher = start(dir, SESSION, changes);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(changes).toEqual([]);
      pipes = [LIVE_PIPE];
      await waitFor(() => changes.length === 1);
      pipes = [];
      await waitFor(() => changes.length === 2);
      expect(changes[1]).toBeNull();
    } finally { watcher.stop(); }
  });

  it('aprende o id da sessão depois: lê o valor atual a cada verificação', async () => {
    const dir = claudeDir();
    writeJob(dir, { backend: 'daemon', state: 'working', sessionId: SESSION });
    const changes: Array<BackgroundJob | null> = [];
    let id: string | null = null;
    const watcher = new BackgroundJobWatcher({ claudeDir: dir, sessionId: () => id, log: silentLogger(), pollMs: 30, listPipes: () => pipes, onChange: (job) => changes.push(job) });
    watcher.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(changes).toEqual([]);
      id = SESSION;
      await waitFor(() => changes.length === 1);
    } finally { watcher.stop(); }
  });

  it('chama onPoll a cada verificação periódica, para reemitir o aviso depois de um recarregamento', async () => {
    const dir = claudeDir();
    writeJob(dir, { backend: 'daemon', state: 'working', sessionId: SESSION });
    const onPoll = vi.fn();
    const watcher = new BackgroundJobWatcher({ claudeDir: dir, sessionId: () => SESSION, log: silentLogger(), pollMs: 30, listPipes: () => pipes, onChange: () => {}, onPoll });
    watcher.start();
    try {
      await waitFor(() => onPoll.mock.calls.length >= 2);
      expect(onPoll).toHaveBeenCalledWith({ id8: '793b7407', state: 'working' });
    } finally { watcher.stop(); }
  });
});

// O /bg cria a conversa em segundo plano com um sessionId NOVO: o vínculo com o terminal é a pasta de sessão
// do lançamento, que aparece no --settings do respawnFlags (formato visto em ~/.claude/jobs/*/state.json).
describe('findBackgroundJob (vínculo pelo sessionDir do lançamento)', () => {
  const SESSION_DIR = 'C:\\Users\\USER\\AppData\\Roaming\\Orquestra\\sessions\\e4f7c968-1e2f-49a8-850e-3351b86279bc';
  const OTHER_DIR = 'C:\\Users\\USER\\AppData\\Roaming\\Orquestra\\sessions\\11111111-2222-3333-4444-555555555555';
  const JOB_SESSION = 'b845e5a9-1111-2222-3333-444444444444';
  const JOB_PIPE = 'cc-daemon-bc8e3d6ca88bafb5-pty-b845e5a9';
  const job = (over: Record<string, unknown> = {}) => ({
    backend: 'daemon', state: 'blocked', sessionId: JOB_SESSION, resumeSessionId: JOB_SESSION,
    respawnFlags: ['--settings', `${SESSION_DIR}\\claude-settings.json`, '--permission-mode', 'bypassPermissions'], ...over,
  });
  const find = (dir: string, sessionDirs: string[], pipes: string[] = [JOB_PIPE, ...PIPES], sessionId?: string) =>
    findBackgroundJob({ claudeDir: dir, sessionDirs, ...(sessionId ? { sessionId } : {}), listPipes: () => pipes });

  it('acha o job de sessionId diferente pelo --settings e devolve o id8 do JOB', () => {
    const dir = claudeDir();
    writeJob(dir, job());
    expect(find(dir, [SESSION_DIR])).toEqual({ id8: 'b845e5a9', state: 'blocked' });
    expect(find(dir, [OTHER_DIR, SESSION_DIR])).toEqual({ id8: 'b845e5a9', state: 'blocked' });
  });

  it('reconhece --settings=<caminho>, barras e maiúsculas diferentes', () => {
    const dir = claudeDir();
    writeJob(dir, job({ respawnFlags: [`--settings=${SESSION_DIR.toUpperCase().replaceAll('\\', '/')}/claude-settings.json`] }));
    expect(find(dir, [SESSION_DIR])).toEqual({ id8: 'b845e5a9', state: 'blocked' });
  });

  it('não acha: sessionDir de outro lançamento, job parado ou done, sem pipe vivo ou sem respawnFlags', () => {
    const dir = claudeDir();
    writeJob(dir, job());
    expect(find(dir, [OTHER_DIR])).toBeNull();
    expect(find(dir, [])).toBeNull();
    expect(find(dir, [SESSION_DIR], PIPES)).toBeNull();
    for (const state of ['stopped', 'done']) {
      writeJob(dir, job({ state }));
      expect(find(dir, [SESSION_DIR])).toBeNull();
    }
    writeJob(dir, job({ respawnFlags: undefined }));
    expect(find(dir, [SESSION_DIR])).toBeNull();
    writeJob(dir, job({ backend: 'local' }));
    expect(find(dir, [SESSION_DIR])).toBeNull();
  });

  it('mantém o vínculo antigo pelo sessionId quando ele coincide', () => {
    const dir = claudeDir();
    writeJob(dir, { backend: 'daemon', state: 'working', sessionId: SESSION });
    expect(find(dir, [], [LIVE_PIPE], SESSION)).toEqual({ id8: '793b7407', state: 'working' });
  });

  it('o watcher usa os sessionDirs mesmo sem sessionId e limpa quando o job para', async () => {
    const dir = claudeDir();
    writeJob(dir, job());
    const changes: Array<BackgroundJob | null> = [];
    const watcher = new BackgroundJobWatcher({ claudeDir: dir, sessionId: () => null, sessionDirs: () => [SESSION_DIR], log: silentLogger(), pollMs: 30, listPipes: () => [JOB_PIPE], onChange: (found) => changes.push(found) });
    watcher.start();
    try {
      await waitFor(() => changes.length === 1);
      expect(changes[0]).toEqual({ id8: 'b845e5a9', state: 'blocked' });
      writeJob(dir, job({ state: 'stopped' }));
      await waitFor(() => changes.length === 2);
      expect(changes[1]).toBeNull();
    } finally { watcher.stop(); }
  });
});
