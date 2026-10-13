import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/log.js';

describe('createLogger', () => {
  it('grava JSON com os campos de correlação no arquivo de log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-log-'));
    const { log, close } = createLogger({ dir, name: 'orquestra' });
    log.child({ sessionId: 's1' }).info({ askId: 'a1' }, 'prompt injetado');
    await close();
    const file = readdirSync(dir).find((entry) => entry.startsWith('orquestra'));
    expect(file).toBeDefined();
    const line = JSON.parse(readFileSync(join(dir, file!), 'utf8').trim().split('\n')[0]!);
    expect(line).toMatchObject({ sessionId: 's1', askId: 'a1', msg: 'prompt injetado' });
  });
});
