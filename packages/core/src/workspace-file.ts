import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyWorkspace, migrateWorkspace, WORKSPACE_DIR, WORKSPACE_FILE, type Workspace } from '@orquestra/shared';

export function workspacePath(projectDir: string): string {
  return join(projectDir, WORKSPACE_DIR, WORKSPACE_FILE);
}

const pad = (value: number) => String(value).padStart(2, '0');
const stamp = (date: Date) =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

/** Arquivo inválido nunca é sobrescrito: vira backup e o projeto abre vazio. */
export function loadWorkspace(projectDir: string, now = new Date()): { workspace: Workspace; backup: string | null; problem: string | null } {
  const file = workspacePath(projectDir);
  if (!existsSync(file)) return { workspace: emptyWorkspace(), backup: null, problem: null };
  try {
    return { workspace: migrateWorkspace(JSON.parse(readFileSync(file, 'utf8'))), backup: null, problem: null };
  } catch (error) {
    const backup = `${file}.invalido-${stamp(now)}`;
    renameSync(file, backup);
    const problem = error instanceof SyntaxError ? `JSON inválido: ${error.message}` : (error as Error).message;
    return { workspace: emptyWorkspace(), backup, problem };
  }
}

export function saveWorkspace(projectDir: string, workspace: Workspace): void {
  const dir = join(projectDir, WORKSPACE_DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  const file = workspacePath(projectDir);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(workspace, null, 2)}\n`);
  renameSync(temporary, file);
}
