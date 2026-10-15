import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { OrqError } from '@orquestra/shared';
import { agyHookGroup } from './adapters/agy.js';

export const DEFAULT_AGY_HOOKS_FILE = join(homedir(), '.gemini', 'config', 'hooks.json');
const GROUP = 'orquestra';

/** O agy interpreta aspas como parte literal do caminho do executável. */
export function agyStopHookCommand(cliScript: string): string {
  if (/[\s"]/.test(cliScript)) {
    throw new OrqError('USAGE', 'O caminho do script do Orquestra para o hook do agy não pode conter espaços ou aspas.');
  }
  return `node ${cliScript} hook agy Stop`;
}

/**
 * O agy não aceita hooks por sessão: o Orquestra instala um grupo próprio no arquivo global.
 * Fora do Orquestra o hook não faz nada (o orq hook sai em silêncio sem ORQ_TOKEN).
 */
export async function ensureAgyGlobalHook(opts: {
  command: string;
  confirm: (message: string) => Promise<boolean>;
  hooksFile?: string;
  now?: () => Date;
}): Promise<'already' | 'installed' | 'declined'> {
  const file = opts.hooksFile ?? DEFAULT_AGY_HOOKS_FILE;
  const exists = existsSync(file);
  let current: Record<string, unknown> = {};
  if (exists) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new OrqError('USAGE', `O arquivo ${file} não é JSON válido. Corrija ou remova o arquivo e tente de novo.`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new OrqError('USAGE', `O arquivo ${file} não tem o formato esperado (um objeto). Corrija e tente de novo.`);
    }
    current = parsed as Record<string, unknown>;
  }
  const desired = agyHookGroup(opts.command);
  if (isDeepStrictEqual(current[GROUP], desired)) return 'already';
  const approved = await opts.confirm(
    `Para detectar o fim das respostas do agy, o Orquestra precisa acrescentar o grupo "${GROUP}" em ${file}. ` +
      'Seus outros hooks continuam iguais e o hook não faz nada fora do Orquestra. Continuar?',
  );
  if (!approved) return 'declined';
  mkdirSync(dirname(file), { recursive: true });
  if (exists) {
    const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    copyFileSync(file, `${file}.orquestra-backup-${stamp}`);
  }
  writeFileSync(file, JSON.stringify({ ...current, [GROUP]: desired }, null, 2));
  return 'installed';
}
