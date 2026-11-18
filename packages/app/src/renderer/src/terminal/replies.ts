import type { IParser } from '@xterm/xterm';

/**
 * Faz o xterm da interface ignorar as consultas do programa (identificação, posição do cursor, modos).
 * Quem responde é o núcleo, que está sempre ligado ao terminal; se a interface respondesse também,
 * o programa receberia duas respostas e a segunda apareceria como texto digitado.
 */
export function muteTerminalReplies(
  term: { parser: Pick<IParser, 'registerCsiHandler' | 'registerDcsHandler' | 'registerOscHandler'> },
): void {
  const swallow = () => true;
  const swallowOscQuery = (data: string) => /(?:^|;)\?$/.test(data);
  term.parser.registerCsiHandler({ final: 'c' }, swallow);
  term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, swallow);
  term.parser.registerCsiHandler({ prefix: '=', final: 'c' }, swallow);
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, swallow);
  term.parser.registerCsiHandler({ final: 'n' }, swallow);
  term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, swallow);
  term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow);
  term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow);
  term.parser.registerCsiHandler({ final: 't' }, swallow);
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow);
  for (const oscId of [4, 10, 11, 12, 104, 110, 111, 112]) {
    term.parser.registerOscHandler(oscId, swallowOscQuery);
  }
}
