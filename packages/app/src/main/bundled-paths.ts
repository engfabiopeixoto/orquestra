import { join } from 'node:path';

/**
 * Resolve os caminhos dos scripts do núcleo e do CLI:
 * - Em produção (empacotado): ficam em extraResources (resourcesPath).
 * - Em desenvolvimento: ficam em dist/ nos pacotes vizinhos do monorepo.
 */
export function bundledScripts(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  mainDir: string;
}): { host: string; cli: string } {
  if (opts.isPackaged) {
    return {
      host: join(opts.resourcesPath, 'host', 'host.mjs'),
      cli: join(opts.resourcesPath, 'cli', 'orq.mjs'),
    };
  }
  return {
    host: join(opts.mainDir, '../../../host/dist/host.mjs'),
    cli: join(opts.mainDir, '../../../cli/dist/orq.mjs'),
  };
}
