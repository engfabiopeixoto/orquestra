import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostToMainSchema, type HostToMain } from '@orquestra/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_SCRIPT } from '../../cli/build.js';

const fixture = fileURLToPath(new URL('./fixtures/test-host.ts', import.meta.url));
let child: ChildProcess | undefined;
afterEach(() => child?.kill());

function startHost() {
  let workspaceId: string | undefined;
  const received: HostToMain[] = [];
  child = spawn(process.execPath, ['--import', 'tsx', fixture], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      ORQ_CLI_SCRIPT: CLI_SCRIPT,
      ORQ_DATA_DIR: mkdtempSync(join(tmpdir(), 'orq-hostdata-')),
      ORQ_BIN_DIR: mkdtempSync(join(tmpdir(), 'orq-hostbin-')),
      ORQ_PIPE_PATH: `\\\\.\\pipe\\orq-hostproc-${randomBytes(4).toString('hex')}`,
    },
  });
  child.stdout?.resume();
  child.stderr?.resume();
  child.on('message', (raw) => received.push(hostToMainSchema.parse(raw)));
  const waitFor = async (predicate: (message: HostToMain) => boolean, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = received.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('Mensagem do núcleo não chegou no prazo.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const command = async (method: string, params: unknown) => {
    const id = randomUUID();
    child!.send({ kind: 'command', id, method, params, workspaceId });
    const response = await waitFor((message) => (message.kind === 'response' || message.kind === 'response-error') && message.id === id);
    if (response.kind === 'response' && method === 'project.open') workspaceId = (response.result as { workspaceId: string }).workspaceId;
    return response;
  };
  return { received, waitFor, command };
}

describe('processo do núcleo (Node puro, IPC real)', () => {
  it('principal desconectado: encerra os terminais e sai com código 0, sem cair ao enviar eventos', async () => {
    const host = startHost();
    await host.waitFor((message) => message.kind === 'ready');
    await host.command('project.open', { dir: mkdtempSync(join(tmpdir(), 'orq-hostproj-')) });
    await host.command('terminal.create', { name: 'A', agent: 'shell' });
    await host.waitFor((message) => message.kind === 'event' && message.event.type === 'terminal.state' && message.event.state === 'idle');
    const exited = new Promise<number | null>((resolve) => child!.once('exit', resolve));
    child!.disconnect();
    expect(await exited).toBe(0);
  });

  it('fica pronto, roda um terminal falso, devolve retrato e encerra no pedido de saída', async () => {
    const host = startHost();
    await host.waitFor((message) => message.kind === 'ready');
    await host.command('project.open', { dir: mkdtempSync(join(tmpdir(), 'orq-hostproj-')) });
    expect(await host.command('terminal.create', { name: 'A', agent: 'shell' })).toMatchObject({ kind: 'response' });
    await host.waitFor((message) => message.kind === 'event' && message.event.type === 'terminal.state' && message.event.state === 'idle');
    await host.command('terminal.input', { name: 'A', data: 'olá\r' });
    await host.waitFor((message) => message.kind === 'event' && message.event.type === 'terminal.output' && message.event.data.includes('eco: olá'));
    const snapshot = await host.command('terminal.snapshot', { name: 'A' });
    expect(snapshot).toMatchObject({ kind: 'response', result: { data: expect.stringContaining('eco: olá') } });
    const exited = new Promise<number | null>((resolve) => child!.once('exit', resolve));
    child!.send({ kind: 'shutdown' });
    expect(await exited).toBe(0);
  });
});
