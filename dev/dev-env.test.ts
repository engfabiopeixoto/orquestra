import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { devEnv } from './dev-env.js';

describe('devEnv', () => {
  it('aplica valores padrão para ambiente de desenvolvimento isolado', () => {
    const base: NodeJS.ProcessEnv = {
      APPDATA: 'C:\\Users\\testuser\\AppData\\Roaming',
      OTHER_VAR: 'hello',
    };
    const result = devEnv(base, 'testuser');

    expect(result.ORQ_PIPE_PATH).toBe('\\\\.\\pipe\\orquestra-dev-testuser');
    expect(result.ORQ_DATA_DIR).toBe(join('C:\\Users\\testuser\\AppData\\Roaming', 'Orquestra-dev'));
    expect(result.ORQ_DEV).toBe('1');
    expect(result.OTHER_VAR).toBe('hello');
    expect(result.ORQ_BIN_DIR).toBeUndefined();
    // Confere que o base original não foi mutado
    expect(base.ORQ_PIPE_PATH).toBeUndefined();
    expect(base.ORQ_DATA_DIR).toBeUndefined();
    expect(base.ORQ_DEV).toBeUndefined();
  });

  it('preserva valores de ORQ_PIPE_PATH e ORQ_DATA_DIR já definidos', () => {
    const base: NodeJS.ProcessEnv = {
      APPDATA: 'C:\\Users\\testuser\\AppData\\Roaming',
      ORQ_PIPE_PATH: '\\\\.\\pipe\\custom-pipe',
      ORQ_DATA_DIR: 'D:\\custom\\data',
    };
    const result = devEnv(base, 'testuser');

    expect(result.ORQ_PIPE_PATH).toBe('\\\\.\\pipe\\custom-pipe');
    expect(result.ORQ_DATA_DIR).toBe('D:\\custom\\data');
    expect(result.ORQ_DEV).toBe('1');
  });

  it('faz fallback para homedir quando APPDATA não estiver definido', () => {
    const base: NodeJS.ProcessEnv = {};
    const result = devEnv(base, 'anotheruser');

    const expectedDataDir = join(homedir(), 'AppData', 'Roaming', 'Orquestra-dev');
    expect(result.ORQ_DATA_DIR).toBe(expectedDataDir);
    expect(result.ORQ_PIPE_PATH).toBe('\\\\.\\pipe\\orquestra-dev-anotheruser');
    expect(result.ORQ_DEV).toBe('1');
  });
});
