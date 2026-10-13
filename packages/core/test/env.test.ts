import { describe, expect, it } from 'vitest';
import { childEnv, prependPath } from '../src/env.js';

describe('childEnv', () => {
  it('remove marcas de sessão do Claude Code herdadas do processo pai', () => {
    const env = childEnv({
      PATH: 'C:/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      ANTHROPIC_API_KEY: 'k',
    });
    expect(env).toEqual({ PATH: 'C:/bin', ANTHROPIC_API_KEY: 'k' });
  });

  it('mantém configurações do Claude Code que o usuário define de propósito', () => {
    const env = childEnv({ CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bin/bash.exe', CLAUDE_CONFIG_DIR: 'C:/c' });
    expect(env).toEqual({ CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bin/bash.exe', CLAUDE_CONFIG_DIR: 'C:/c' });
  });
});

describe('prependPath', () => {
  it('usa a chave Path existente do Windows em vez de criar outra', () => {
    expect(prependPath({ Path: 'C:/a' }, 'C:/orq')).toEqual({ Path: 'C:/orq;C:/a' });
  });

  it('cria PATH quando não existe', () => {
    expect(prependPath({}, 'C:/orq')).toEqual({ PATH: 'C:/orq' });
  });
});
