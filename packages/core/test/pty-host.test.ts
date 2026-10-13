import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnv } from '../src/env.js';
import { nodePtyHost } from '../src/pty-host.js';
import { resolveExecutable } from '../src/resolve-exe.js';

describe('resolveExecutable', () => {
  it('resolve .exe direto e .cmd via cmd.exe', () => {
    expect(resolveExecutable('node').file.toLowerCase()).toMatch(/node\.exe$/);
    const npm = resolveExecutable('npm');
    expect(npm.file.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(npm.argsPrefix.slice(0, 2)).toEqual(['/d', '/c']);
  });

  it('falha com mensagem clara quando não encontra', () => {
    expect(() => resolveExecutable('nao-existe-orq-xyz')).toThrow(/não encontrado no PATH/);
  });
});

describe('nodePtyHost', () => {
  it('kill não bloqueia o event loop com o taskkill', async () => {
    const node = resolveExecutable('node');
    const pty = nodePtyHost.spawn({ file: node.file, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: tmpdir(), env: childEnv(process.env) });
    const startedAt = Date.now();
    const killing = pty.kill();
    // Nesta máquina: taskkill síncrono ~115 ms; assíncrono ~10 ms (até ~40 ms com a suíte inteira rodando).
    expect(Date.now() - startedAt).toBeLessThan(80);
    await killing;
  });

  it('roda no ConPTY numa pasta com espaço e acento e entrega UTF-8', async () => {
    const cwd = join(mkdtempSync(join(tmpdir(), 'orq ')), 'pasta ação');
    mkdirSync(cwd);
    const node = resolveExecutable('node');
    const pty = nodePtyHost.spawn({
      file: node.file,
      args: ['-e', 'process.stdout.write("olá " + process.cwd())'],
      cwd,
      env: childEnv(process.env),
    });
    let output = '';
    pty.onData((data) => (output += data));
    const code = await new Promise<number>((resolve) => pty.onExit(resolve));
    expect(code).toBe(0);
    expect(output).toContain('olá');
    expect(output).toContain('pasta ação');
  });

  it('usa o ConPTY do node-pty (OpenConsole) e não deixa OpenConsole órfão depois do kill', async () => {
    // O ConPTY do Windows 10 conta "❯" como 2 colunas e desloca o texto que o usuário digita no Claude.
    const openConsoles = () =>
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='OpenConsole.exe' and ParentProcessId=${process.pid}" | Measure-Object).Count`], {
        encoding: 'utf8',
      }).trim();
    const node = resolveExecutable('node');
    const pty = nodePtyHost.spawn({ file: node.file, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: tmpdir(), env: childEnv(process.env) });
    expect(openConsoles()).toBe('1');
    await pty.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(openConsoles()).toBe('0');
  });

  it('escrever enquanto o processo morre não derruba o núcleo e avisa quem ouve', async () => {
    // O node-pty não ouve erros do pipe de entrada: um EAGAIN aqui viraria exceção não tratada.
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      const node = resolveExecutable('node');
      const pty = nodePtyHost.spawn({ file: node.file, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: tmpdir(), env: childEnv(process.env) });
      const errors: Error[] = [];
      pty.onError((error) => errors.push(error));
      // Escreve antes, durante e depois do kill: o pipe fecha em algum ponto do caminho.
      const writer = setInterval(() => pty.write('[?1;2c'), 1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await pty.kill();
      await new Promise((resolve) => setTimeout(resolve, 500));
      clearInterval(writer);
      expect(uncaught).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('kill espera o processo terminar', async () => {
    const node = resolveExecutable('node');
    const pty = nodePtyHost.spawn({ file: node.file, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: tmpdir(), env: childEnv(process.env) });
    let exited = false;
    pty.onExit(() => (exited = true));
    await pty.kill();
    expect(exited).toBe(true);
  });
});
