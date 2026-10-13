import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { OrqError, type MethodName } from '@orquestra/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../core/src/log.js';
import { startPipeServer } from '../../core/src/pipe-server.js';
import { run } from '../src/run.js';

type Handler = (method: MethodName, params: unknown) => Promise<unknown>;
let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

async function cli(argv: string[], handler: Handler, opts: { stdin?: string; env?: Record<string, string | undefined> } = {}) {
  const pipePath = `\\\\.\\pipe\\orq-cli-${randomBytes(4).toString('hex')}`;
  const server = await startPipeServer({
    pipePath,
    authenticate: (token) => (token === 'tok' ? { session: 'A' } : undefined),
    dispatch: (method, params) => handler(method, params),
    log: silentLogger(),
  });
  close = server.close;
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdin: Readable.from([opts.stdin ?? '']),
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env: opts.env ?? { ORQ_PIPE: pipePath, ORQ_TOKEN: 'tok' },
  });
  return { code, stdout, stderr };
}

describe('orq', () => {
  it('hook Codex recebe o payload pelo argumento notify', async () => {
    const payload = { type: 'agent-turn-complete', 'thread-id': 'abc', 'last-assistant-message': 'Olá\nFeito.' };
    let received: unknown;
    const result = await cli(['hook', 'codex', 'Stop', JSON.stringify(payload)], async (method, params) => {
      expect(method).toBe('hook');
      received = params;
      return {};
    });
    expect(result.code).toBe(0);
    expect(received).toEqual({ agent: 'codex', event: 'Stop', payload });
  });
  it('prompt imprime a resposta e sai com 0', async () => {
    let received: unknown;
    const result = await cli(['prompt', 'B', 'quanto é 2+2?'], async (_m, params) => {
      received = params;
      return { status: 'answered', askId: 'x', answer: '4' };
    });
    expect(result).toMatchObject({ code: 0, stdout: '4\n' });
    expect(received).toEqual({ target: 'B', text: 'quanto é 2+2?', timeoutMs: 480_000 });
  });

  it('prompt lê o texto do stdin com - e respeita --timeout', async () => {
    let received: unknown;
    await cli(['prompt', 'B', '-', '--timeout', '30s'], async (_m, params) => {
      received = params;
      return { status: 'answered', askId: 'x', answer: 'ok' };
    }, { stdin: 'linha 1\nlinha 2' });
    expect(received).toEqual({ target: 'B', text: 'linha 1\nlinha 2', timeoutMs: 30_000 });
  });

  it('prompt lê o texto de --file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'orq-cli-')), 'p.txt');
    writeFileSync(file, 'do arquivo ✅');
    let received: { text?: string } = {};
    await cli(['prompt', 'B', '--file', file], async (_m, params) => {
      received = params as { text: string };
      return { status: 'answered', askId: 'x', answer: 'ok' };
    });
    expect(received.text).toBe('do arquivo ✅');
  });

  it('prompt pendente sai com 0 e explica', async () => {
    const result = await cli(['prompt', 'B', 'x'], async () => ({ status: 'pending', askId: 'id9' }));
    expect(result).toMatchObject({ code: 0, stdout: 'pendente: id=id9; a resposta será entregue no seu terminal\n' });
  });

  it('erro do app vira mensagem no stderr e código de saída da spec', async () => {
    const result = await cli(['prompt', 'C', 'x'], async () => {
      throw new OrqError('NOT_CONNECTED', 'C não está conectado a você. Conecte os dois no canvas.');
    });
    expect(result).toMatchObject({ code: 3, stderr: 'C não está conectado a você. Conecte os dois no canvas.\n' });
  });

  it('prompt que falhou sai com 6', async () => {
    const result = await cli(['prompt', 'B', 'x'], async () => {
      throw new OrqError('PROMPT_FAILED', 'O pedido para B falhou: o turno foi interrompido.');
    });
    expect(result.code).toBe(6);
  });

  it('peers lista nome, tipo, estado e fila', async () => {
    const result = await cli(['peers'], async () => ({
      peers: [{ name: 'B', agent: 'agy', state: 'busy', queued: 2 }],
    }));
    expect(result.stdout).toBe('B\tagy\tbusy\t2 na fila\n');
  });

  it('--json imprime o resultado estruturado', async () => {
    const result = await cli(['whoami', '--json'], async () => ({ name: 'A', agent: 'claude' }));
    expect(JSON.parse(result.stdout)).toEqual({ name: 'A', agent: 'claude' });
  });

  it('note write lê do stdin e informa a revisão', async () => {
    let received: unknown;
    const result = await cli(['note', 'write', 'plano', '-'], async (_m, params) => {
      received = params;
      return { name: 'plano', revision: 1, created: true };
    }, { stdin: '# Plano' });
    expect(received).toEqual({ name: 'plano', content: '# Plano' });
    expect(result.stdout).toBe('nota plano criada (rev 1)\n');
  });

  it('result de pedido que falhou sai com 6', async () => {
    const result = await cli(['result', 'id1'], async () => ({ status: 'failed', reason: 'o turno foi interrompido' }));
    expect(result.code).toBe(6);
  });

  it('comando desconhecido é uso inválido', async () => {
    const result = await cli(['ask', 'B', 'x'], async () => ({}));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Comando desconhecido/);
  });

  it('sem ORQ_PIPE e ORQ_TOKEN explica que precisa rodar num terminal do Orquestra', async () => {
    const result = await cli(['peers'], async () => ({ peers: [] }), { env: {} });
    expect(result.code).toBe(4);
    expect(result.stderr).toMatch(/terminal do Orquestra/);
  });

  it('hook sempre sai com 0, mesmo com o app fora do ar, e imprime {} para o agy', async () => {
    const result = await cli(['hook', 'agy', 'Stop'], async () => ({}), {
      stdin: '{}',
      env: { ORQ_PIPE: '\\\\.\\pipe\\orq-nao-existe', ORQ_TOKEN: 'tok' },
    });
    expect(result).toMatchObject({ code: 0, stdout: '{}' });
  });

  it('hook repassa o payload cru', async () => {
    let received: unknown;
    await cli(['hook', 'claude', 'Stop'], async (_m, params) => {
      received = params;
      return {};
    }, { stdin: '{"last_assistant_message":"oi"}' });
    expect(received).toEqual({ agent: 'claude', event: 'Stop', payload: { last_assistant_message: 'oi' } });
  });

  it('new cria terminal e repassa opções ao pipe', async () => {
    let received: unknown;
    const result = await cli(
      ['new', 'X', '--agent', 'claude', '--persona', 'revisor', '--args', '--model opus', '--cwd', 'C:/p', '--no-resume'],
      async (m, params) => {
        expect(m).toBe('regent.new');
        received = params;
        return { name: 'X' };
      },
    );
    expect(result).toMatchObject({ code: 0, stdout: 'terminal X criado\n' });
    expect(received).toEqual({
      name: 'X',
      agent: 'claude',
      persona: 'revisor',
      args: ['--model', 'opus'],
      cwd: 'C:/p',
      resume: false,
    });
  });

  it('new sem --agent falha com USAGE', async () => {
    const result = await cli(['new', 'X'], async () => ({}));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Falta --agent \(claude, agy, codex ou shell\)\./);
  });

  it('persona write com - lê do stdin e repassa --global', async () => {
    let received: unknown;
    const result = await cli(
      ['persona', 'write', 'p', '-', '--global'],
      async (m, params) => {
        expect(m).toBe('persona.write');
        received = params;
        return { name: 'p', scope: 'global', created: true };
      },
      { stdin: 'Instruções da persona' },
    );
    expect(result).toMatchObject({ code: 0, stdout: 'função p criada (global)\n' });
    expect(received).toEqual({ name: 'p', text: 'Instruções da persona', global: true });
  });

  it('persona list imprime nome e escopo', async () => {
    const result = await cli(['persona', 'list'], async (m) => {
      expect(m).toBe('persona.list');
      return { personas: [{ name: 'revisor', scope: 'project' }] };
    });
    expect(result).toMatchObject({ code: 0, stdout: 'revisor\tprojeto\n' });
  });

  it('persona list vazio imprime Nenhuma função.', async () => {
    const result = await cli(['persona', 'list'], async () => ({ personas: [] }));
    expect(result).toMatchObject({ code: 0, stdout: 'Nenhuma função.\n' });
  });

  it('link e unlink conectam e desconectam nós', async () => {
    let calledMethod = '';
    let received: unknown;
    const resLink = await cli(['link', 'A', 'B'], async (m, params) => {
      calledMethod = m;
      received = params;
      return {};
    });
    expect(resLink).toMatchObject({ code: 0, stdout: 'A e B conectados\n' });
    expect(calledMethod).toBe('regent.link');
    expect(received).toEqual({ a: 'A', b: 'B' });

    const resUnlink = await cli(['unlink', 'A', 'B'], async (m, params) => {
      calledMethod = m;
      received = params;
      return {};
    });
    expect(resUnlink).toMatchObject({ code: 0, stdout: 'A e B desconectados\n' });
    expect(calledMethod).toBe('regent.unlink');
    expect(received).toEqual({ a: 'A', b: 'B' });
  });

  it('remove e brief chamam os métodos do pipe', async () => {
    let removeParams: unknown;
    const resRemove = await cli(['remove', 'B'], async (m, params) => {
      expect(m).toBe('regent.remove');
      removeParams = params;
      return {};
    });
    expect(resRemove).toMatchObject({ code: 0, stdout: 'B removido\n' });
    expect(removeParams).toEqual({ name: 'B' });

    let briefParams: unknown;
    const resBrief = await cli(['brief', 'B', 'revisor'], async (m, params) => {
      expect(m).toBe('regent.brief');
      briefParams = params;
      return {};
    });
    expect(resBrief).toMatchObject({ code: 0, stdout: 'função revisor entregue a B\n' });
    expect(briefParams).toEqual({ target: 'B', persona: 'revisor' });
  });

  it('persona show e persona remove', async () => {
    const resShow = await cli(['persona', 'show', 'p'], async (m, params) => {
      expect(m).toBe('persona.show');
      expect(params).toEqual({ name: 'p' });
      return { name: 'p', scope: 'project', text: 'Texto da persona' };
    });
    expect(resShow).toMatchObject({ code: 0, stdout: 'Texto da persona\n' });

    const resRemove = await cli(['persona', 'remove', 'p', '--global'], async (m, params) => {
      expect(m).toBe('persona.remove');
      expect(params).toEqual({ name: 'p', global: true });
      return {};
    });
    expect(resRemove).toMatchObject({ code: 0, stdout: 'função p removida\n' });
  });

  it('erro NOT_REGENT do pipe sai com código 5 e mensagem no stderr', async () => {
    const result = await cli(['new', 'X', '--agent', 'shell'], async () => {
      throw new OrqError('NOT_REGENT', 'A não é regente. Marque a opção "Regente" no terminal para usar este comando.');
    });
    expect(result.code).toBe(5);
    expect(result.stderr).toBe('A não é regente. Marque a opção "Regente" no terminal para usar este comando.\n');
  });

  it('ajuda mostra os comandos do regente', async () => {
    const result = await cli(['--help'], async () => ({}));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Regente:');
    expect(result.stderr).toContain('orq new');
    expect(result.stderr).toContain('orq remove');
    expect(result.stderr).toContain('orq link');
    expect(result.stderr).toContain('orq unlink');
    expect(result.stderr).toContain('orq brief');
    expect(result.stderr).toContain('orq persona');
  });
});
