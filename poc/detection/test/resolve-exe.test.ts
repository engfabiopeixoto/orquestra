import { describe, expect, it } from 'vitest';
import { resolveExecutable } from '../src/resolve-exe.js';

describe('resolveExecutable', () => {
  it('resolve um .exe do PATH para o caminho completo', () => {
    const resolved = resolveExecutable('node');
    expect(resolved.file.toLowerCase()).toMatch(/node\.exe$/);
    expect(resolved.argsPrefix).toEqual([]);
  });

  it('envolve um .cmd em cmd.exe /d /c', () => {
    const resolved = resolveExecutable('npm');
    expect(resolved.file.toLowerCase()).toMatch(/cmd\.exe$/);
    expect(resolved.argsPrefix[0]).toBe('/d');
    expect(resolved.argsPrefix[1]).toBe('/c');
    expect(resolved.argsPrefix[2]?.toLowerCase()).toMatch(/npm\.cmd$/);
  });

  it('usa o cmd.exe do System32 quando ComSpec não está definido', () => {
    const saved = process.env.ComSpec;
    delete process.env.ComSpec;
    try {
      expect(resolveExecutable('npm').file).toBe('C:\\Windows\\System32\\cmd.exe');
    } finally {
      process.env.ComSpec = saved;
    }
  });

  it('falha com mensagem clara quando não encontra', () => {
    expect(() => resolveExecutable('nao-existe-orq-xyz')).toThrow(/não encontrado no PATH/);
  });
});
