const ESC = 0x1b;
const BEL = 0x07;

/**
 * Sequência de escape aberta no fim da saída, ou ''.
 *
 * O ConPTY corta a saída em pedaços arbitrários (`ESC[5` num pedaço, `d` no seguinte). O retrato da tela
 * não guarda esse estado do parser; sem anexar o resto ao retrato, o xterm da interface recebe só `d`
 * e o imprime como texto.
 */
export function incompleteEscapeTail(data: string): string {
  const start = data.lastIndexOf('\x1b');
  if (start < 0) return '';
  const tail = data.slice(start);
  // O último ESC pode ser o terminador (ESC \) de um OSC/DCS aberto antes: confere a partir do anterior.
  if (tail.length >= 2 && tail[1] === '\\') {
    const previous = data.lastIndexOf('\x1b', start - 1);
    if (previous >= 0 && isStringSequence(data.charCodeAt(previous + 1))) return '';
  }
  if (isComplete(tail)) return '';
  // ESC solto no fim pode ser o começo do terminador (ESC \) de um OSC/DCS ainda aberto: o resto começa nele.
  if (tail.length === 1) {
    const previous = data.lastIndexOf('\x1b', start - 1);
    if (previous >= 0 && isStringSequence(data.charCodeAt(previous + 1)) && !data.slice(previous, start).includes('\x07')) {
      return data.slice(previous);
    }
  }
  return tail;
}

function isStringSequence(code: number): boolean {
  // OSC (]), DCS (P), SOS (X), PM (^), APC (_): terminam com BEL ou ESC \.
  return code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f;
}

function isComplete(sequence: string): boolean {
  if (sequence.length < 2) return false;
  const kind = sequence.charCodeAt(1);
  if (kind === 0x5b) {
    // CSI: parâmetros e intermediários (0x20–0x3F) até um byte final (0x40–0x7E).
    for (let index = 2; index < sequence.length; index++) {
      const code = sequence.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return true;
    }
    return false;
  }
  if (isStringSequence(kind)) {
    for (let index = 2; index < sequence.length; index++) {
      const code = sequence.charCodeAt(index);
      if (code === BEL) return true;
      if (code === ESC) return index + 1 < sequence.length && sequence[index + 1] === '\\';
    }
    return false;
  }
  // ESC + intermediários (0x20–0x2F) + final (0x30–0x7E), como ESC ( B; ou ESC + final direto, como ESC 7.
  for (let index = 1; index < sequence.length; index++) {
    const code = sequence.charCodeAt(index);
    if (code >= 0x30 && code <= 0x7e) return true;
    if (code < 0x20 || code > 0x2f) return true;
  }
  return false;
}
