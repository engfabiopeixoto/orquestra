import { homedir } from 'node:os';
import { join } from 'node:path';

export function devEnv(base: NodeJS.ProcessEnv, username: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };

  // ORQ_BIN_DIR continua a padrão: o hook global do agy aponta para o caminho do orq.mjs; com pastas diferentes, um reescreveria o hook do outro.
  env.ORQ_PIPE_PATH = base.ORQ_PIPE_PATH ?? `\\\\.\\pipe\\orquestra-dev-${username}`;

  const defaultDataDir = base.APPDATA
    ? join(base.APPDATA, 'Orquestra-dev')
    : join(homedir(), 'AppData', 'Roaming', 'Orquestra-dev');

  env.ORQ_DATA_DIR = base.ORQ_DATA_DIR ?? defaultDataDir;
  env.ORQ_DEV = '1';

  return env;
}
