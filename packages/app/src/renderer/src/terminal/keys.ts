export type TerminalKeyAction = 'copy' | 'paste' | 'pass';

/**
 * Teclas de área de transferência no terminal, no padrão do Windows Terminal:
 * Ctrl+V e Ctrl+Shift+V colam texto; Ctrl+C copia se houver seleção (sem seleção, interrompe o agente);
 * Ctrl+Shift+C copia. Alt+V segue para o agente (o Claude Code cola imagem com ele no Windows).
 */
export function terminalKeyAction(
  event: { type: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  hasSelection: boolean,
): TerminalKeyAction {
  if (event.type !== 'keydown' || !event.ctrlKey || event.altKey) return 'pass';
  if (event.code === 'KeyV') return 'paste';
  if (event.code === 'KeyC' && (hasSelection || event.shiftKey)) return 'copy';
  return 'pass';
}
