import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { OrqError } from '@orquestra/shared';

export type NodePathDeps = {
  env: Record<string, string | undefined>;
  where: () => string | null;
  exists?: (path: string) => boolean;
};

/** O núcleo roda no Node do sistema; um app aberto pelo Explorer pode ter outro PATH, então guardamos o caminho absoluto. */
export function resolveNodePath(deps: NodePathDeps): string {
  const exists = deps.exists ?? existsSync;
  const fromEnv = deps.env.ORQ_NODE_PATH;
  if (fromEnv) {
    if (exists(fromEnv)) return fromEnv;
    throw new OrqError('APP_UNAVAILABLE', `ORQ_NODE_PATH aponta para ${fromEnv}, que não existe. Corrija a variável ou remova-a.`);
  }
  const found = deps
    .where()
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith('node.exe'));
  if (found) return found;
  throw new OrqError('APP_UNAVAILABLE', 'Node 22 não encontrado. Instale o Node 22 ou defina ORQ_NODE_PATH com o caminho do node.exe.');
}

export function whereNode(): string | null {
  try {
    return execFileSync('where.exe', ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}
