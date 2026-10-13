import { describe, expect, it } from 'vitest';
import { ActivityMonitor, shouldNotify } from '../src/main/activity';

const terminal = (name: string, overrides = {}) => ({ name, agent: 'claude', state: 'idle' as const, queued: 0, cwd: 'C:/p', resume: true, args: [], regente: false, monitor: true, ...overrides });

function setup(focused = false) {
  const shown: Array<{ name: string; title: string; body: string }> = [];
  let now = 1_000_000;
  const monitor = new ActivityMonitor({ isFocused: () => focused, notify: (n) => shown.push(n), now: () => now });
  monitor.observeResult('project.open', { dir: 'C:/p' }, { dir: 'C:/p', name: 'proj', terminals: [terminal('A'), terminal('S', { agent: 'shell', monitor: false })], notes: [], edges: [], layout: {}, viewport: { x: 0, y: 0, zoom: 1 } });
  return { monitor, shown, advance: (ms: number) => (now += ms) };
}

describe('shouldNotify', () => {
  it('só com a janela fora de foco, monitor ligado e fora do intervalo', () => {
    const base = { focused: false, monitor: true, reason: 'turn' as const, lastNotifiedAt: undefined, now: 50_000 };
    expect(shouldNotify(base)).toBe(true);
    expect(shouldNotify({ ...base, focused: true })).toBe(false);
    expect(shouldNotify({ ...base, monitor: false })).toBe(false);
    expect(shouldNotify({ ...base, lastNotifiedAt: 45_000 })).toBe(false);
    expect(shouldNotify({ ...base, lastNotifiedAt: 40_000 })).toBe(true);
  });
});

describe('ActivityMonitor', () => {
  it('notifica o projeto em segundo plano mesmo com a janela focada e nomes repetidos', () => {
    const shown: Array<{ workspaceId?: string; body: string }> = [];
    const monitor = new ActivityMonitor({ isFocused: () => true, notify: (notice) => shown.push(notice) });
    monitor.observeResult('project.open', {}, { workspaceId: 'A', name: 'alfa', terminals: [terminal('S')] });
    monitor.observeResult('project.open', {}, { workspaceId: 'B', name: 'beta', terminals: [terminal('S')] });
    monitor.observeEvent({ type: 'terminal.turn', workspaceId: 'B', name: 'S', owner: 'user', outcome: 'ended' });
    monitor.observeEvent({ type: 'terminal.turn', workspaceId: 'A', name: 'S', owner: 'user', outcome: 'ended' });
    expect(shown).toEqual([expect.objectContaining({ workspaceId: 'A', body: 'claude · alfa' })]);
    monitor.observeResult('project.close', {}, {}, 'B');
    monitor.observeEvent({ type: 'terminal.state', workspaceId: 'A', name: 'S', state: 'waiting', queued: 0 });
    expect(shown).toHaveLength(2);
  });
  it('turno do usuário notifica com título e corpo', () => {
    const { monitor, shown } = setup();
    monitor.observeEvent({ type: 'terminal.turn', name: 'A', owner: 'user', outcome: 'ended' });
    expect(shown).toEqual([{ name: 'A', title: 'A terminou', body: 'claude · proj' }]);
  });

  it('turno falho do usuário também notifica', () => {
    const { monitor, shown } = setup();
    monitor.observeEvent({ type: 'terminal.turn', name: 'A', owner: 'user', outcome: 'failed' });
    expect(shown).toHaveLength(1);
  });

  it('turno do broker não notifica', () => {
    const { monitor, shown } = setup();
    monitor.observeEvent({ type: 'terminal.turn', name: 'A', owner: 'broker', outcome: 'ended' });
    expect(shown).toEqual([]);
  });

  it('entrar em waiting notifica; continuar em waiting não', () => {
    const { monitor, shown } = setup();
    monitor.observeEvent({ type: 'terminal.state', name: 'A', state: 'waiting', queued: 0 });
    monitor.observeEvent({ type: 'terminal.state', name: 'A', state: 'waiting', queued: 0 });
    expect(shown).toEqual([{ name: 'A', title: 'A está aguardando você', body: 'claude · proj' }]);
  });

  it('intervalo de 10 s por terminal e motivo', () => {
    const { monitor, shown, advance } = setup();
    const turn = { type: 'terminal.turn', name: 'A', owner: 'user', outcome: 'ended' } as const;
    monitor.observeEvent(turn);
    advance(5_000);
    monitor.observeEvent(turn);
    monitor.observeEvent({ type: 'terminal.state', name: 'A', state: 'waiting', queued: 0 });
    advance(5_000);
    monitor.observeEvent(turn);
    expect(shown.map((n) => n.title)).toEqual(['A terminou', 'A está aguardando você', 'A terminou']);
  });

  it('monitor desligado, janela em foco ou terminal desconhecido não notificam', () => {
    const { monitor, shown } = setup();
    monitor.observeEvent({ type: 'terminal.turn', name: 'S', owner: 'user', outcome: 'ended' });
    monitor.observeEvent({ type: 'terminal.turn', name: 'X', owner: 'user', outcome: 'ended' });
    expect(shown).toEqual([]);
    const focused = setup(true);
    focused.monitor.observeEvent({ type: 'terminal.turn', name: 'A', owner: 'user', outcome: 'ended' });
    expect(focused.shown).toEqual([]);
  });

  it('terminal.added registra o monitor do terminal novo; update troca nome e opção', () => {
    const { monitor, shown } = setup();
    monitor.observeEvent({ type: 'terminal.added', info: terminal('N'), rect: { x: 0, y: 0, width: 1, height: 1 }, connectedTo: 'A' });
    monitor.observeEvent({ type: 'terminal.turn', name: 'N', owner: 'user', outcome: 'ended' });
    expect(shown).toHaveLength(1);
    monitor.observeResult('terminal.update', { name: 'N', newName: 'N2', monitor: false }, terminal('N2', { monitor: false }));
    monitor.observeEvent({ type: 'terminal.turn', name: 'N2', owner: 'user', outcome: 'ended' });
    monitor.observeEvent({ type: 'terminal.turn', name: 'N', owner: 'user', outcome: 'ended' });
    expect(shown).toHaveLength(1);
  });
});
