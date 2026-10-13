import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agyHooksJson, createAgyDriver, readAgyTranscript } from '../src/drivers/agy.js';
import type { HookEnvelope } from '../src/types.js';

const envelope = (payload: unknown): HookEnvelope => ({ agent: 'agy', event: 'Stop', payload, receivedAt: 0 });
const line = (stepIndex: number, content: string, extra: object = {}) =>
  JSON.stringify({ step_index: stepIndex, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content, ...extra });

function transcript(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'orq agy ')), 'transcript_full.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

describe('agyHooksJson', () => {
  it('usa Stop plano, sem matcher, com o relay sem aspas', () => {
    const json = agyHooksJson('C:/tmp/sessao/hook-relay.mjs') as Record<string, { Stop: Array<Record<string, unknown>> }>;
    const group = Object.values(json)[0]!;
    expect(group.Stop[0]).toMatchObject({ type: 'command', command: 'node C:/tmp/sessao/hook-relay.mjs agy Stop' });
    expect(group.Stop[0]).not.toHaveProperty('matcher');
  });

  // O agy divide o comando nos espaços e ignora as aspas (visto no cli.log do agy 1.3.2).
  it('recusa caminho do relay com espaço', () => {
    expect(() => agyHooksJson('C:/Meus Projetos/hook-relay.mjs')).toThrow(/espaço/);
  });
});

describe('createAgyDriver.launch', () => {
  it('copia o relay para a pasta da sessão e grava .agents/hooks.json apontando para a cópia', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'orq-agy-'));
    const workDir = join(sessionDir, 'work');
    const spec = createAgyDriver().launch({ workDir, sessionDir });
    const relayCopy = join(sessionDir, 'hook-relay.mjs').replaceAll('\\', '/');
    expect(spec.name).toBe('agy');
    expect(readFileSync(relayCopy, 'utf8')).toContain('ORQ_POC_PIPE');
    expect(JSON.parse(readFileSync(join(workDir, '.agents', 'hooks.json'), 'utf8'))).toEqual(agyHooksJson(relayCopy));
  });
});

describe('readAgyTranscript', () => {
  it('devolve o último PLANNER_RESPONSE do modelo com conteúdo', async () => {
    const path = transcript([
      line(1, 'primeira'),
      JSON.stringify({ step_index: 2, source: 'USER', type: 'USER_INPUT', content: 'oi' }),
      line(3, '', { tool_calls: [{ name: 'run_command' }] }),
      line(4, 'ação final'),
      'linha corrompida',
    ]);
    expect(await readAgyTranscript(path, -1)).toEqual({ text: 'ação final', stepIndex: 4 });
  });

  const userInput = (stepIndex: number) =>
    JSON.stringify({ step_index: stepIndex, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>x' });

  it('não aceita texto intermediário que acompanha uma chamada de ferramenta', async () => {
    const path = transcript([userInput(1), line(2, 'vou listar os arquivos', { tool_calls: [{ name: 'run_command' }] })]);
    expect(await readAgyTranscript(path, -1)).toBeNull();
  });

  it('não aceita resposta anterior ao último prompt do usuário', async () => {
    const path = transcript([userInput(1), line(2, 'resposta do turno anterior'), userInput(3)]);
    expect(await readAgyTranscript(path, -1)).toBeNull();
  });

  it('ignora respostas de turnos já entregues', async () => {
    const path = transcript([line(1, 'antiga')]);
    expect(await readAgyTranscript(path, 1)).toBeNull();
  });

  it('devolve null com arquivo ausente', async () => {
    expect(await readAgyTranscript('C:/nao/existe.jsonl', -1)).toBeNull();
  });
});

describe('agy contra dados reais', () => {
  it('interpreta o Stop real', () => {
    const real = JSON.parse(readFileSync(new URL('../fixtures/agy/stop.json', import.meta.url), 'utf8')) as HookEnvelope;
    expect(createAgyDriver().interpret(real).kind).toBe('turn-end');
  });

  it('extrai texto da transcrição real', async () => {
    const path = fileURLToPath(new URL('../fixtures/agy/transcript_full.jsonl', import.meta.url));
    expect((await readAgyTranscript(path, -1))?.text).toBe('TANGERINA-42');
  });
});

describe('createAgyDriver', () => {
  it('Stop com fullyIdle vira turn-end sem texto e com a transcrição', () => {
    const signal = createAgyDriver().interpret(
      envelope({ conversationId: 'a1', transcriptPath: 'C:/t.jsonl', fullyIdle: true, terminationReason: 'NO_TOOL_CALL' }),
    );
    expect(signal).toEqual({ kind: 'turn-end', text: null, transcriptPath: 'C:/t.jsonl', sessionId: 'a1' });
  });

  it('Stop sem fullyIdle é ignorado', () => {
    expect(createAgyDriver().interpret(envelope({ conversationId: 'a1', transcriptPath: 'C:/t.jsonl', fullyIdle: false }))).toEqual({
      kind: 'ignored',
    });
  });

  it('readTranscript não repete a resposta do turno anterior', async () => {
    const driver = createAgyDriver();
    const path = transcript([line(1, 'turno 1')]);
    expect(await driver.readTranscript!(path)).toBe('turno 1');
    expect(await driver.readTranscript!(path)).toBeNull();
  });
});
