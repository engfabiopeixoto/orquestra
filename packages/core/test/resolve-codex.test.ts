import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveExecutable } from '../src/resolve-exe.js';

describe('Codex com PATH do Explorer', () => {
  const home = mkdtempSync(join(tmpdir(), 'orq-codex-'));
  const env = { USERPROFILE: home, LOCALAPPDATA: join(home, 'Local'), APPDATA: join(home, 'Roaming') };
  const deps = { env, nodePath: join(home, 'system-node', 'node.exe'), where: () => { throw new Error('not found'); } };
  it('encontra uma instalação mise fora do PATH', () => {
    const dir = join(env.LOCALAPPDATA, 'mise', 'installs', 'node', '22.23.2');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'codex.cmd');
    writeFileSync(file, '@echo off');
    expect(resolveExecutable('codex', deps).argsPrefix).toEqual(['/d', '/c', file]);
  });
  it('prefere o programa já resolvido no PATH', () => {
    expect(resolveExecutable('codex', { ...deps, where: () => ['C:/custom/codex.exe'] })).toEqual({ file: 'C:/custom/codex.exe', argsPrefix: [] });
  });
  it('devolve erro acionável quando o programa não existe', () => {
    expect(() => resolveExecutable('missing-orq', deps)).toThrow(expect.objectContaining({ code: 'APP_UNAVAILABLE' }));
  });
  it('executa o launcher npm diretamente sem interpretar argumentos no cmd.exe', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'orq-codex-launcher-'));
    const launcher = join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    mkdirSync(join(prefix, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    writeFileSync(launcher, '');
    const nodePath = join(prefix, 'node.exe');
    expect(resolveExecutable('codex', { where: () => [join(prefix, 'codex.cmd')], nodePath })).toEqual({ file: nodePath, argsPrefix: [launcher] });
  });
});
