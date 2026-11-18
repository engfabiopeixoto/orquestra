import { Terminal } from '@xterm/xterm';

/** O que a tela precisa de um terminal: só leitura, no tamanho do PTY do PC. */
export type TerminalView = {
  /** Troca o conteúdo: limpa, ajusta ao tamanho do PTY do PC e escreve o retrato. */
  load(data: string, cols: number, rows: number, availableWidth: number): void;
  write(data: string): void;
  dispose(): void;
};

export const MIN_FONT_PX = 9;
export const MAX_FONT_PX = 14;
const CHAR_WIDTH_RATIO = 0.6;

/**
 * Corpo da fonte para que `cols` colunas caibam em `availableWidth`. O celular nunca redimensiona o PTY do PC:
 * encolhe a letra até MIN_FONT_PX e, se ainda não couber, a área rola na horizontal.
 */
export function fontSizeForWidth(availableWidth: number, cols: number): { fontSize: number; scrollsHorizontally: boolean } {
  if (!(availableWidth > 0) || cols < 1) return { fontSize: MAX_FONT_PX, scrollsHorizontally: false };
  const ideal = Math.floor(availableWidth / (cols * CHAR_WIDTH_RATIO));
  if (ideal < MIN_FONT_PX) return { fontSize: MIN_FONT_PX, scrollsHorizontally: true };
  return { fontSize: Math.min(ideal, MAX_FONT_PX), scrollsHorizontally: false };
}

export function createXtermView(container: HTMLElement): TerminalView {
  const term = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 5000,
    disableStdin: true,
    cursorBlink: false,
    convertEol: false,
    fontFamily: '"Cascadia Mono", Consolas, ui-monospace, monospace',
    theme: { background: '#0d0f13', foreground: '#d6dae2' },
  });
  term.open(container);
  return {
    load(data, cols, rows, availableWidth) {
      term.reset();
      term.options.fontSize = fontSizeForWidth(availableWidth, cols).fontSize;
      term.resize(cols, rows);
      term.write(data);
      term.scrollToBottom();
    },
    write(data) {
      term.write(data);
    },
    dispose() {
      term.dispose();
    },
  };
}
