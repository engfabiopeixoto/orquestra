import type { IParser } from '@xterm/xterm';

/**
 * Faz o xterm da interface ignorar as consultas do programa (identificação, posição do cursor, modos).
 * Quem responde é o núcleo, que está sempre ligado ao terminal; se a interface respondesse também,
 * o programa receberia duas respostas e a segunda apareceria como texto digitado.
 */
export function muteTerminalReplies(term: { parser: Pick<IParser, 'registerCsiHandler' | 'registerDcsHandler'> }): void {
  const swallow = () => true;
  term.parser.registerCsiHandler({ final: 'c' }, swallow);
  term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, swallow);
  term.parser.registerCsiHandler({ final: 'n' }, swallow);
  term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, swallow);
  term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow);
  term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow);
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow);
}
