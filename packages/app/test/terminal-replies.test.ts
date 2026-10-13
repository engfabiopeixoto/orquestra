import xtermHeadless from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { muteTerminalReplies } from '../src/renderer/src/terminal/replies';

const { Terminal } = xtermHeadless;

function terminalWithReplies() {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const replies: string[] = [];
  term.onData((data) => replies.push(data));
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  return { term, replies, write };
}

// Mesmas consultas que o núcleo responde: o xterm da interface responderia de novo e o programa receberia duas respostas.
const QUERIES = {
  'identificação (DA1)': '\x1b[c',
  'identificação secundária (DA2)': '\x1b[>c',
  'posição do cursor (CPR)': '\x1b[6n',
  'estado (DSR)': '\x1b[5n',
  'posição do cursor DEC': '\x1b[?6n',
  'modo ANSI (DECRQM)': '\x1b[4$p',
  'modo DEC (DECRQM)': '\x1b[?25$p',
  'configuração (DECRQSS)': '\x1bP$qm\x1b\\',
};

describe('muteTerminalReplies', () => {
  it('sem silenciar, o xterm responde às consultas (garante que o teste mede algo)', async () => {
    const { replies, write } = terminalWithReplies();
    for (const query of Object.values(QUERIES)) await write(query);
    expect(replies.length).toBe(Object.keys(QUERIES).length);
  });

  it.each(Object.entries(QUERIES))('não responde a %s', async (_label, query) => {
    const { term, replies, write } = terminalWithReplies();
    muteTerminalReplies(term);
    await write(query);
    expect(replies).toEqual([]);
  });

  it('continua desenhando o resto da saída', async () => {
    const { term, write } = terminalWithReplies();
    muteTerminalReplies(term);
    await write('a\x1b[cb\x1b[1mc');
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('abc');
  });
});
