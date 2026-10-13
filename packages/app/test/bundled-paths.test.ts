import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledScripts } from '../src/main/bundled-paths';

describe('bundledScripts', () => {
  it('em desenvolvimento aponta para os pacotes vizinhos a partir do mainDir', () => {
    const mainDir = 'C:\\repo\\packages\\app\\out\\main';
    const scripts = bundledScripts({ isPackaged: false, resourcesPath: 'C:\\resources', mainDir });
    expect(scripts).toEqual({
      host: join(mainDir, '../../../host/dist/host.mjs'),
      cli: join(mainDir, '../../../cli/dist/orq.mjs'),
    });
  });

  it('empacotado aponta para extraResources (resourcesPath)', () => {
    const resourcesPath = 'C:\\Program Files\\Orquestra\\resources';
    const scripts = bundledScripts({ isPackaged: true, resourcesPath, mainDir: 'C:\\qualquer' });
    expect(scripts).toEqual({
      host: join(resourcesPath, 'host', 'host.mjs'),
      cli: join(resourcesPath, 'cli', 'orq.mjs'),
    });
  });
});
