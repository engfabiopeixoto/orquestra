import { APP_ACTIONS, type AppAction } from '../shared/app-action';

export function isAppAction(value: unknown): value is AppAction {
  return typeof value === 'string' && (APP_ACTIONS as readonly string[]).includes(value);
}

type KeyInput = { type: string; key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean };

/**
 * Atalhos que o menu escondido não garante no Windows.
 * Ctrl+R e Ctrl+Shift+I ficam livres: pertencem ao terminal.
 */
export function appShortcut(input: KeyInput): AppAction | null {
  if (input.type !== 'keyDown' || input.alt || input.meta) return null;
  if (input.key === 'F12' && !input.control && !input.shift) return 'devtools';
  if (input.key === 'F5' && input.control && input.shift) return 'reload';
  return null;
}

export type AppActionDeps = { openLogs(): void; reload(): void; toggleDevTools(): void; quit(): void; warn(message: string): void };

/** Executa uma ação vinda do renderer; devolve false (e registra) quando ela não existe. */
export function handleAppAction(action: unknown, deps: AppActionDeps): boolean {
  if (!isAppAction(action)) {
    deps.warn(`Ação do app desconhecida: ${String(action)}`);
    return false;
  }
  if (action === 'open-logs') deps.openLogs();
  else if (action === 'reload') deps.reload();
  else if (action === 'devtools') deps.toggleDevTools();
  else deps.quit();
  return true;
}
