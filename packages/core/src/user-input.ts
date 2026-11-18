/** Remove relatórios e respostas automáticas do terminal que não representam teclas do usuário. */
export function keyboardInput(data: string): string {
  return data
    .replace(/\x1b\[(?:I|O)/g, '')
    .replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '')
    .replace(/\x1b\[M[\s\S]{3}/g, '')
    // Normaliza sequências win32-input do Codex (\x1b[Vk;Sc;Uc;Kd;Cs;Rc_): descarta keyup (Kd=0) e traduz keydown.
    .replace(/\x1b\[(\d+);\d+;(\d+);([01]);\d+;\d+_/g, (match, vk: string, uc: string, kd: string) => {
      if (kd === '0') return '';
      const codePoint = Number(uc);
      if (codePoint > 0) return String.fromCodePoint(codePoint);
      if (vk === '38') return '\x1b[A';
      if (vk === '40') return '\x1b[B';
      return match;
    })
    // Respostas OSC (ex.: cores OSC 4/10/11/12) e DCS/SOS/PM/APC (ex.: XTVERSION, DECRQSS)
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    // Limitação conhecida: F3 modificado no xterm (\x1b[1;2R, \x1b[1;3R, \x1b[1;5R) compartilha a sintaxe VT de CPR.
    // Os bytes continuam indo ao PTY em Session.userInput, mas hasUserKeystroke retorna false; muteTerminalReplies no renderer é a barreira primária.
    // Relatórios CSI: posição do cursor (CPR), status (DSR), atributos (DA1/2/3), modos (DECRPM), janela (XTWINOPS) e gráficos (XTSRGA)
    .replace(/\x1b\[\??\d+;\d+R/g, '')
    .replace(/\x1b\[\??\d+(?:;\d+)*n/g, '')
    .replace(/\x1b\[[?>=][0-9;]*c/g, '')
    .replace(/\x1b\[\??[0-9;]*\$y/g, '')
    .replace(/\x1b\[[0-9;]*t/g, '')
    .replace(/\x1b\[\?[0-9;]*S/g, '');
}

/** Indica se a entrada contém algo que o usuário digitou, ignorando foco e relatórios do mouse. */
export function hasUserKeystroke(data: string): boolean {
  return keyboardInput(data).length > 0;
}
