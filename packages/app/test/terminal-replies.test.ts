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

const EXTRA_QUERIES = {
  'identificação terciária (DA3)': '\x1b[=c',
  'versão do terminal (XTVERSION)': '\x1b[>q',
  'cor de frente (OSC 10)': '\x1b]10;?\x07',
  'cor de fundo (OSC 11)': '\x1b]11;?\x1b\\',
  'cor de cursor (OSC 12)': '\x1b]12;?\x07',
  'cor da paleta (OSC 4)': '\x1b]4;0;?\x1b\\',
  'operação de janela (XTWINOPS)': '\x1b[18t',
};

describe('muteTerminalReplies', () => {
  it('sem silenciar, o xterm responde às consultas (garante que o teste mede algo)', async () => {
    const { replies, write } = terminalWithReplies();
    for (const query of Object.values(QUERIES)) await write(query);
    expect(replies.length).toBe(Object.keys(QUERIES).length);
  });

  it.each(Object.entries({ ...QUERIES, ...EXTRA_QUERIES }))('não responde a %s', async (_label, query) => {
    const { term, replies, write } = terminalWithReplies();
    muteTerminalReplies(term);
    await write(query);
    expect(replies).toEqual([]);
  });

  it('registra handlers para OSC, DA3, XTVERSION e XTWINOPS', () => {
    const csi: unknown[] = [];
    const dcs: unknown[] = [];
    const osc: number[] = [];
    muteTerminalReplies({
      parser: {
        registerCsiHandler: (id, cb) => { csi.push(id); expect(cb([])).toBe(true); return { dispose() {} }; },
        registerDcsHandler: (id, cb) => { dcs.push(id); expect(cb('', [])).toBe(true); return { dispose() {} }; },
        registerOscHandler: (ident, cb) => { osc.push(ident); expect(cb('?')).toBe(true); return { dispose() {} }; },
      },
    });
    expect(osc).toEqual(expect.arrayContaining([4, 10, 11, 12, 104, 110, 111, 112]));
    expect(csi).toEqual(expect.arrayContaining([
      { prefix: '=', final: 'c' },
      { prefix: '>', final: 'q' },
      { final: 't' },
    ]));
    expect(dcs).toEqual(expect.arrayContaining([
      { intermediates: '$', final: 'q' },
    ]));
  });

  it('continua desenhando o resto da saída', async () => {
    const { term, write } = terminalWithReplies();
    muteTerminalReplies(term);
    await write('a\x1b[cb\x1b[1mc');
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('abc');
  });
});
