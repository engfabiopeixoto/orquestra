import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLI_SCRIPT } from '../../cli/build.js';
import { installCli } from '../src/cli-install.js';
import { silentLogger } from '../src/log.js';
import { createOrquestra, type Orquestra } from '../src/orquestra.js';
import { createFakeAdapter } from './helpers/fake-adapter.js';
import { waitFor } from './helpers/wait.js';

let cliScript: string;
let orquestra: Orquestra | undefined;

beforeAll(() => {
  cliScript = installCli({ script: CLI_SCRIPT, binDir: mkdtempSync(join(tmpdir(), 'orq-bin-')) }).script;
});

afterEach(async () => {
  await orquestra?.close();
  orquestra = undefined;
});

async function setup(envB: Record<string, string> = {}) {
  orquestra = await createOrquestra({
    pipePath: `\\\\.\\pipe\\orq-it-${randomBytes(4).toString('hex')}`,
    dataDir: mkdtempSync(join(tmpdir(), 'orq-data-')),
    cliScript,
    adapters: {
      fake: createFakeAdapter(),
      fakeB: createFakeAdapter(envB),
      quebrado: { ...createFakeAdapter(), launch: () => ({ command: 'nao-existe-orq-xyz', args: [], env: {} }) },
    },
    log: silentLogger(),
    readyQuietMs: 300,
    typingGuardMs: 0,
  });
  const cwd = mkdtempSync(join(tmpdir(), 'orq-cwd-'));
  const a = orquestra.createTerminal({ name: 'A', agent: 'fake', cwd });
  const b = orquestra.createTerminal({ name: 'B', agent: 'fakeB', cwd });
  orquestra.connect('A', 'B');
  await waitFor(() => a.state === 'idle' && b.state === 'idle', 10_000);
  return { orq: orquestra, a, b };
}

function orq(as: string, args: string[], stdin = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliScript, ...args], {
      env: { ...process.env, ORQ_PIPE: orquestra!.pipePath, ORQ_TOKEN: orquestra!.tokenFor(as) ?? 'desconhecido' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe('núcleo de ponta a ponta', () => {
  it('prompt de A para B volta com a resposta de B, com Unicode', async () => {
    await setup();
    await expect(orq('A', ['prompt', 'B', 'olá ✅ × 2'])).resolves.toMatchObject({ code: 0, stdout: 'eco: olá ✅ × 2\n' });
  });

  it('prompt com várias linhas pelo stdin chega inteiro', async () => {
    await setup();
    await expect(orq('A', ['prompt', 'B', '-'], 'linha 1\nlinha 2')).resolves.toMatchObject({ stdout: 'eco: linha 1 | linha 2\n' });
  });

  it('prazo esgotado devolve pendente e a resposta chega depois no terminal de A', async () => {
    const { a } = await setup({ FAKE_FIRST_DELAY_MS: '2500' });
    const first = await orq('A', ['prompt', 'B', 'demorado', '--timeout', '500ms']);
    expect(first.code).toBe(0);
    const askId = /pendente: id=(\S+);/.exec(first.stdout)?.[1];
    expect(askId).toBeDefined();
    await waitFor(() => a.screenText().includes('[orq] Resposta de B'), 15_000);
    await expect(orq('A', ['result', askId!])).resolves.toMatchObject({ code: 0, stdout: 'eco: demorado\n' });
  });

  it('se o orq de A é morto antes da resposta, a resposta chega depois no terminal de A', async () => {
    const { a } = await setup({ FAKE_FIRST_DELAY_MS: '2500' });
    const child = spawn(process.execPath, [cliScript, 'prompt', 'B', 'morto'], {
      env: { ...process.env, ORQ_PIPE: orquestra!.pipePath, ORQ_TOKEN: orquestra!.tokenFor('A')! },
    });
    child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 800));
    child.kill();
    await waitFor(() => a.screenText().includes('[orq] Resposta de B'), 15_000);
  });

  it('prompt para terminal não conectado sai com 3', async () => {
    const { orq: o } = await setup();
    o.createTerminal({ name: 'C', agent: 'fake', cwd: tmpdir() });
    await expect(orq('A', ['prompt', 'C', 'x'])).resolves.toMatchObject({ code: 3 });
  });

  it('turno interrompido sai com 6 e explica', async () => {
    await setup();
    const result = await orq('A', ['prompt', 'B', 'INTERROMPA agora']);
    expect(result.code).toBe(6);
    expect(result.stderr).toMatch(/interrompido/);
  });

  it('remover B com o prompt em curso falha o prompt de A', async () => {
    const { orq: o } = await setup({ FAKE_FIRST_DELAY_MS: '5000' });
    const pending = orq('A', ['prompt', 'B', 'x']);
    await waitFor(() => o.session('B')!.state === 'busy');
    await o.removeTerminal('B');
    const result = await pending;
    expect(result.code).toBe(6);
    expect(result.stderr).toMatch(/removido/);
  });

  it('notas: criar conecta ao autor; show, append e list; quem não está conectado não vê', async () => {
    await setup();
    await expect(orq('A', ['note', 'write', 'plano', '-'], '# Plano ✅')).resolves.toMatchObject({ stdout: 'nota plano criada (rev 1)\n' });
    await expect(orq('A', ['note', 'append', 'plano', '\n- item'])).resolves.toMatchObject({ stdout: 'nota plano atualizada (rev 2)\n' });
    await expect(orq('A', ['note', 'show', 'plano'])).resolves.toMatchObject({ stdout: '# Plano ✅\n- item\n' });
    await expect(orq('A', ['note', 'list'])).resolves.toMatchObject({ stdout: 'plano (rev 2)\n' });
    await expect(orq('B', ['note', 'show', 'plano'])).resolves.toMatchObject({ code: 3 });
  });

  it('read devolve a tela de B e peers lista B', async () => {
    await setup();
    await expect(orq('A', ['read', 'B'])).resolves.toMatchObject({ stdout: expect.stringContaining('fake pronto') });
    await expect(orq('A', ['peers'])).resolves.toMatchObject({ stdout: 'B\tfake\tidle\n' });
  });

  it('hook de outro tipo de agente com o token de B é ignorado', async () => {
    await setup({ FAKE_FIRST_DELAY_MS: '2500' });
    const pending = orq('A', ['prompt', 'B', 'x']);
    await waitFor(() => orquestra!.session('B')!.state === 'busy');
    await orq('B', ['hook', 'agy', 'Stop'], '{"fullyIdle":true}');
    await expect(pending).resolves.toMatchObject({ code: 0, stdout: 'eco: x\n' });
  });

  it('criar terminal com agente que não existe não prende o nome', async () => {
    const { orq: o } = await setup();
    expect(() => o.createTerminal({ name: 'C', agent: 'quebrado', cwd: tmpdir() })).toThrow(/não encontrado no PATH/);
    expect(o.topology.kindOf('C')).toBeUndefined();
    expect(() => o.createTerminal({ name: 'C', agent: 'fake', cwd: tmpdir() })).not.toThrow();
  });

  it('criar terminal numa pasta que não existe explica o problema e não prende o nome', async () => {
    const { orq: o } = await setup();
    const missing = join(tmpdir(), 'orq-pasta-que-nao-existe-xyz');
    expect(() => o.createTerminal({ name: 'C', agent: 'fake', cwd: missing })).toThrow(/A pasta .* não existe/);
    expect(o.topology.kindOf('C')).toBeUndefined();
  });

  it('hook com token desconhecido sai com 0 e não afeta o app', async () => {
    await setup();
    await expect(orq('ninguém', ['hook', 'fake', 'Stop'], '{}')).resolves.toMatchObject({ code: 0 });
    await expect(orq('A', ['whoami'])).resolves.toMatchObject({ stdout: 'A (fake)\n' });
  });
});
