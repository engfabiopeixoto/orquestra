import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHost, EXTERNAL_MODULES } from './build.js';

const here = fileURLToPath(new URL('.', import.meta.url));

export async function packHost(): Promise<string> {
  console.log('Construindo o bundle do núcleo...');
  const hostScript = await buildHost();

  const distPack = join(here, 'dist-pack');
  rmSync(distPack, { recursive: true, force: true });
  mkdirSync(distPack, { recursive: true });

  copyFileSync(hostScript, join(distPack, 'host.mjs'));

  const corePkg = JSON.parse(readFileSync(join(here, '../core/package.json'), 'utf8'));
  const hostPkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
  const availableDeps = { ...corePkg.dependencies, ...hostPkg.dependencies };

  const dependencies: Record<string, string> = {};
  for (const ext of EXTERNAL_MODULES) {
    const version = availableDeps[ext];
    if (!version || version === '*') {
      throw new Error(`Versão exata para a dependência externa "${ext}" não encontrada em packages/core ou packages/host.`);
    }
    dependencies[ext] = version;
  }

  const packageJson = {
    name: 'orquestra-host',
    private: true,
    type: 'module',
    dependencies,
  };

  writeFileSync(join(distPack, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  console.log('Instalando dependências de produção do núcleo em dist-pack...');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    execFileSync(
      npmCmd,
      ['install', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund'],
      {
        cwd: distPack,
        stdio: 'inherit',
        shell: true,
      },
    );
  } catch (error) {
    console.error('Falha ao instalar dependências em dist-pack:', error);
    throw error;
  }

  console.log('Pacote do núcleo pronto em:', distPack);
  return distPack;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await packHost();
}
