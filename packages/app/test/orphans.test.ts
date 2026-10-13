import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killRecordedAgents } from '../src/main/orphans';

describe('killRecordedAgents', () => {
  it('encerra a árvore de cada agente registrado e apaga o registro', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orq-orphans-')), 'agentes-ativos.json');
    writeFileSync(file, JSON.stringify([11, 22]));
    const killed: number[] = [];
    await expect(killRecordedAgents(file, async (pid) => void killed.push(pid))).resolves.toEqual([11, 22]);
    expect(killed).toEqual([11, 22]);
    expect(existsSync(file)).toBe(false);
  });

  it('sem registro (ou registro inválido), não encerra nada', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-orphans-'));
    const killed: number[] = [];
    await expect(killRecordedAgents(join(dir, 'nada.json'), async (pid) => void killed.push(pid))).resolves.toEqual([]);
    writeFileSync(join(dir, 'ruim.json'), '{x');
    await expect(killRecordedAgents(join(dir, 'ruim.json'), async (pid) => void killed.push(pid))).resolves.toEqual([]);
    expect(killed).toEqual([]);
  });
});
