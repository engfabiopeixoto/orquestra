/**
 * Com zoom diferente de 100% o terminal fica somente leitura e uma camada ("duplo clique para interagir")
 * o cobre. Sem este repasse a roda sobre a camada ia para o React Flow, que a trata como rolagem do canvas
 * (panOnScroll): o canvas andava e o histórico do terminal ficava inacessível.
 *
 * Comportamento por agente, com a roda repassada ao xterm (medido no Claude Code 2.1.300 e no agy 1.3.4):
 * - shell (e agy): buffer normal, sem mouse tracking. O xterm rola o próprio histórico (scrollback).
 * - claude: tela alternativa + mouse tracking. Não há histórico no xterm: ele envia a roda ao agente como
 *   evento de mouse (ESC[<64;col;rowM) e é a interface do Claude que rola a conversa.
 * - codex: não foi possível medir (CLI ausente na máquina de teste); segue o mesmo caminho do xterm.
 */

type WheelTerm = { options: { disableStdin?: boolean } };

/**
 * Entrega ao xterm uma cópia da roda recebida na camada. Devolve true quando tratou o evento.
 * Ctrl e Meta ficam com o canvas (zoom). A entrada do xterm é liberada só durante o envio: o terminal
 * continua somente leitura, e apenas a roda (rolagem ou evento de mouse da TUI) chega ao agente.
 */
export function forwardWheelToTerminal(term: WheelTerm, xtermElement: Element | null, event: WheelEvent): boolean {
  if (!xtermElement || event.ctrlKey || event.metaKey) return false;
  event.preventDefault();
  event.stopPropagation();
  const forwarded = new WheelEvent('wheel', {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    // Não sobe para o React Flow: a roda já foi consumida aqui.
    bubbles: false,
    cancelable: true,
  });
  const previous = term.options.disableStdin;
  term.options.disableStdin = false;
  try {
    xtermElement.dispatchEvent(forwarded);
  } finally {
    term.options.disableStdin = previous;
  }
  return true;
}

type ScrollTerm = {
  readonly rows: number;
  readonly buffer: { readonly active: { readonly type: string } };
  readonly modes: { readonly mouseTrackingMode: string };
  scrollLines(amount: number): void;
};

/** Converte a roda em linhas inteiras do terminal, guardando a fração (trackpad) para o próximo evento. */
export function wheelToLines(event: { deltaY: number; deltaMode: number }, cellHeight: number, rows: number, carry: number): { lines: number; carry: number } {
  const unit = event.deltaMode === 1 ? event.deltaY : event.deltaMode === 2 ? event.deltaY * rows : event.deltaY / cellHeight;
  const total = unit + carry;
  const lines = Math.trunc(total);
  return { lines, carry: total - lines };
}

/**
 * Rola o histórico (buffer normal, sem mouse tracking) direto no buffer do xterm.
 * O caminho padrão do xterm move o scrollTop do DOM e depende do evento de scroll para sincronizar o buffer:
 * se a saída do terminal chega no mesmo quadro, com o viewport no fim, ela sobrescreve o deslocamento e a roda se perde.
 * Em tela alternativa ou com mouse tracking (TUIs) devolve false: o xterm envia a roda ao agente.
 */
export function applyWheelScroll(term: ScrollTerm, event: WheelEvent, cellHeight: number, state: { carry: number }): boolean {
  if (event.ctrlKey || event.metaKey || cellHeight <= 0) return false;
  if (term.buffer.active.type !== 'normal' || term.modes.mouseTrackingMode !== 'none') return false;
  event.preventDefault();
  event.stopPropagation();
  const { lines, carry } = wheelToLines(event, cellHeight, term.rows, state.carry);
  state.carry = carry;
  if (lines !== 0) term.scrollLines(lines);
  return true;
}

/**
 * Ctrl (ou Meta) + roda é sempre zoom do canvas. O corpo do terminal tem `nowheel`, então o React Flow ignora
 * qualquer roda cujo alvo esteja nele e o xterm a trataria (rolar o histórico ou enviá-la ao agente).
 * Esta função consome o evento e o reemite a partir de um elemento fora do `nowheel` (o nó), de onde sobe ao canvas.
 */
export function forwardWheelToCanvas(event: WheelEvent, canvasTarget: Element | null): boolean {
  if (!canvasTarget || !(event.ctrlKey || event.metaKey)) return false;
  event.preventDefault();
  event.stopPropagation();
  canvasTarget.dispatchEvent(new WheelEvent('wheel', {
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    bubbles: true,
    cancelable: true,
  }));
  return true;
}
