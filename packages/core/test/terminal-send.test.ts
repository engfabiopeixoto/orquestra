import { describe, expect, it } from 'vitest';
import type { AgentAdapter } from '../src/adapters/types.js';
import { silentLogger } from '../src/log.js';
import { Screen } from '../src/screen.js';
import { Session } from '../src/session.js';
import { encodeTerminalKey } from '../src/terminal-keys.js';
import { FakePty } from './helpers/fake-pty.js';
import { waitFor } from './helpers/wait.js';

const adapterOf = (kind: string, extra: Partial<AgentAdapter> = {}): AgentAdapter => ({
  kind: kind as AgentAdapter['kind'],
  acceptsPrompts: true,
  screenRules: [],
  launch: () => ({ command: 'x', args: [], env: {} }),
  interpretHook: () => ({ kind: 'ignored' }),
  preparePrompt: (text) => text,
  ...extra,
});

async function setup(kind = 'claude', extra: Partial<AgentAdapter> = {}) {
  const pty = new FakePty();
  const session = new Session({ id: 'id1', name: 'W', adapter: adapterOf(kind, extra), pty, cwd: '.', log: silentLogger(), readyQuietMs: 20, idleGraceMs: 30, commandSubmitDelayMs: 5 });
  pty.emitData('pronto> ');
  await waitFor(() => session.state === 'idle');
  return { pty, session };
}

describe('Screen: modos do terminal', () => {
  it('acompanha colagem delimitada (2004), modo de aplicação das setas e Win32 (9001)', async () => {
    const screen = new Screen(40, 10);
    expect([screen.bracketedPaste, screen.applicationCursorKeys, screen.win32Input]).toEqual([false, false, false]);
    await screen.write('\x1b[?2004h\x1b[?1h\x1b[?9001h');
    expect([screen.bracketedPaste, screen.applicationCursorKeys, screen.win32Input]).toEqual([true, true, true]);
    await screen.write('\x1b[?2004l\x1b[?1l\x1b[?9001l');
    expect([screen.bracketedPaste, screen.applicationCursorKeys, screen.win32Input]).toEqual([false, false, false]);
  });
});

describe('encodeTerminalKey', () => {
  const vt = { win32: false, applicationCursor: false };
  it('usa sequências VT comuns e respeita o modo de aplicação nas setas', () => {
    expect(encodeTerminalKey('Enter', vt)).toBe('\r');
    expect(encodeTerminalKey('Escape', vt)).toBe('\x1b');
    expect(encodeTerminalKey('Tab', vt)).toBe('\t');
    expect(encodeTerminalKey('CtrlC', vt)).toBe('\x03');
    expect(encodeTerminalKey('Digit2', vt)).toBe('2');
    expect(encodeTerminalKey('ArrowUp', vt)).toBe('\x1b[A');
    expect(encodeTerminalKey('ArrowDown', { win32: false, applicationCursor: true })).toBe('\x1bOB');
  });
  it('com Win32 ligado envia o par pressionada/solta no mesmo formato do desktop', () => {
    const win = { win32: true, applicationCursor: false };
    expect(encodeTerminalKey('Enter', win)).toBe('\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_');
    expect(encodeTerminalKey('ArrowUp', win)).toBe('\x1b[38;72;0;1;256;1_\x1b[38;72;0;0;256;1_');
    expect(encodeTerminalKey('CtrlC', win)).toBe('\x1b[67;46;3;1;8;1_\x1b[67;46;3;0;8;1_');
  });
});

describe('Session.sendMessage e sendKey', () => {
  it('texto de uma linha em terminal sem colagem delimitada é digitado como está, seguido de Enter', async () => {
    const { pty, session } = await setup('claude');
    await session.sendMessage('ls -la');
    expect(pty.written).toEqual(['ls -la', '\r']);
  });

  it('com a colagem delimitada ligada (2004) ou várias linhas cola entre marcadores e envia Enter', async () => {
    const one = await setup('claude');
    one.pty.emitData('\x1b[?2004h');
    await waitFor(() => true);
    await new Promise((r) => setTimeout(r, 20));
    await one.session.sendMessage('oi');
    expect(one.pty.written).toEqual(['\x1b[200~oi\x1b[201~', '\r']);

    const multi = await setup('claude');
    await multi.session.sendMessage('linha 1\r\nlinha 2\n');
    expect(multi.pty.written).toEqual(['\x1b[200~linha 1\nlinha 2\x1b[201~', '\r']);
  });

  it('remove marcadores de colagem e controles do texto e aplica a codificação do adaptador (agy)', async () => {
    const { pty, session } = await setup('agy', { encodeInput: (body) => `<${body}>` });
    await session.sendMessage('a\x1b[201~b\x1b[31m\nc');
    expect(pty.written[0]).toBe('<\x1b[200~a[201~b[31m\nc\x1b[201~>');
  });

  it('conta como digitação do usuário e abre o turno com o Enter', async () => {
    const { session } = await setup('claude');
    await session.sendMessage('faça algo');
    expect(session.state).toBe('busy');
  });

  it('terminal encerrado recusa mensagem e tecla', async () => {
    const { pty, session } = await setup('claude');
    pty.emitExit(0);
    await waitFor(() => session.state === 'exited');
    await expect(session.sendMessage('oi')).rejects.toMatchObject({ code: 'APP_UNAVAILABLE' });
    expect(() => session.sendKey('Enter')).toThrow(/Recarregue/);
  });

  it('Codex com DECSET 9001 recebe a tecla no formato Win32; sem o modo, VT comum; outros agentes sempre VT', async () => {
    const codex = await setup('codex');
    codex.session.sendKey('Enter');
    expect(codex.pty.written.at(-1)).toBe('\r');
    codex.pty.emitData('\x1b[?9001h');
    await new Promise((r) => setTimeout(r, 30));
    codex.session.sendKey('Enter');
    expect(codex.pty.written.at(-1)).toBe('\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_');

    const claude = await setup('claude');
    claude.pty.emitData('\x1b[?9001h');
    await new Promise((r) => setTimeout(r, 30));
    claude.session.sendKey('Enter');
    expect(claude.pty.written.at(-1)).toBe('\r');
  });
});
