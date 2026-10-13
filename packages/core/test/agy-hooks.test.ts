import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureAgyGlobalHook } from '../src/agy-hooks.js';

const command = 'node C:/orq/bin/orq.mjs hook agy Stop';
const fileIn = () => join(mkdtempSync(join(tmpdir(), 'orq-agy-')), 'config', 'hooks.json');

describe('ensureAgyGlobalHook', () => {
  it('pede confirmação, cria o arquivo e grava o grupo orquestra', async () => {
    const hooksFile = fileIn();
    const asked: string[] = [];
    const result = await ensureAgyGlobalHook({ command, hooksFile, confirm: async (message) => (asked.push(message), true) });
    expect(result).toBe('installed');
    expect(asked[0]).toContain(hooksFile);
    expect(JSON.parse(readFileSync(hooksFile, 'utf8'))).toEqual({
      orquestra: { Stop: [{ type: 'command', command, timeout: 10 }] },
    });
  });

  it('preserva os grupos existentes e faz backup', async () => {
    const hooksFile = fileIn();
    await ensureAgyGlobalHook({ command, hooksFile, confirm: async () => true });
    writeFileSync(hooksFile, JSON.stringify({ meu: { Stop: [{ type: 'command', command: 'x' }] } }));
    const result = await ensureAgyGlobalHook({ command, hooksFile, confirm: async () => true, now: () => new Date('2026-10-09T10:00:00Z') });
    expect(result).toBe('installed');
    const saved = JSON.parse(readFileSync(hooksFile, 'utf8'));
    expect(saved.meu).toEqual({ Stop: [{ type: 'command', command: 'x' }] });
    expect(saved.orquestra).toBeDefined();
    expect(readdirSync(join(hooksFile, '..')).some((name) => name.startsWith('hooks.json.orquestra-backup-'))).toBe(true);
  });

  it('não pergunta nem altera quando o grupo já está igual', async () => {
    const hooksFile = fileIn();
    await ensureAgyGlobalHook({ command, hooksFile, confirm: async () => true });
    let asked = false;
    const result = await ensureAgyGlobalHook({ command, hooksFile, confirm: async () => (asked = true) });
    expect(result).toBe('already');
    expect(asked).toBe(false);
  });

  it('recusa da confirmação não escreve nada', async () => {
    const hooksFile = fileIn();
    expect(await ensureAgyGlobalHook({ command, hooksFile, confirm: async () => false })).toBe('declined');
    expect(existsSync(hooksFile)).toBe(false);
  });

  it('arquivo inválido é erro de uso e fica intacto', async () => {
    const hooksFile = fileIn();
    await ensureAgyGlobalHook({ command, hooksFile, confirm: async () => true });
    writeFileSync(hooksFile, '[1, 2');
    await expect(ensureAgyGlobalHook({ command, hooksFile, confirm: async () => true })).rejects.toMatchObject({ code: 'USAGE' });
    expect(readFileSync(hooksFile, 'utf8')).toBe('[1, 2');
  });
});
