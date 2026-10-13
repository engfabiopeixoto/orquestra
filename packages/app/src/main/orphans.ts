import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

/**
 * O núcleo caiu: o taskkill /T dele não acha mais os filhos, então encerramos a árvore de cada agente
 * pelo registro que o núcleo mantinha. Devolve os PIDs tratados.
 */
export async function killRecordedAgents(file: string, killTree: (pid: number) => Promise<void>): Promise<number[]> {
  let pids: number[];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    pids = Array.isArray(parsed) ? parsed.filter((pid): pid is number => Number.isInteger(pid) && pid > 0) : [];
  } catch {
    return [];
  }
  for (const pid of pids) await killTree(pid);
  rmSync(file, { force: true });
  return pids;
}

export function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}
