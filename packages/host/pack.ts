import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  pruneDistPack(distPack);
  console.log('Pacote do núcleo pronto em:', distPack);
  return distPack;
}

function removePdbFiles(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) removePdbFiles(full);
    else if (entry.name.toLowerCase().endsWith('.pdb')) rmSync(full, { force: true });
  }
}

function pruneDistPack(distPack: string): void {
  const nodeModules = join(distPack, 'node_modules');
  removePdbFiles(nodeModules);
  const ptyDir = join(nodeModules, 'node-pty');
  for (const dir of ['third_party', 'deps', 'src']) {
    rmSync(join(ptyDir, dir), { recursive: true, force: true });
  }
  const prebuilds = join(ptyDir, 'prebuilds');
  try {
    for (const entry of readdirSync(prebuilds, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'win32-arm64' || entry.name.startsWith('darwin-'))) {
        rmSync(join(prebuilds, entry.name), { recursive: true, force: true });
      }
    }
  } catch { /* Sem pasta prebuilds. */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await packHost();
}
