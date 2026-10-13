import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractLastAssistantFromTranscript } from '../src/drivers/transcript.js';

function transcript(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'orq tr ')), 't.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
}

describe('extractLastAssistantFromTranscript', () => {
  it('devolve os blocos de texto da última mensagem do assistente', async () => {
    const path = transcript([
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'antigo' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'oi' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ação ' }, { type: 'text', text: 'final' }] },
      }),
      'linha corrompida',
    ]);
    expect(await extractLastAssistantFromTranscript(path)).toBe('ação final');
  });

  const user = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
  const assistant = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });

  it('não devolve a resposta do turno anterior quando o prompt atual ainda não foi respondido', async () => {
    const path = transcript([user('p1'), assistant([{ type: 'text', text: 'r1' }]), user('p2')]);
    expect(await extractLastAssistantFromTranscript(path)).toBeNull();
  });

  it('resultado de ferramenta não reinicia o turno, e texto junto de tool_use não é resposta final', async () => {
    const intermediate = assistant([{ type: 'text', text: 'vou ler' }, { type: 'tool_use', name: 'Read' }]);
    const toolResult = user([{ type: 'tool_result', content: 'conteúdo' }]);
    expect(await extractLastAssistantFromTranscript(transcript([user('p'), intermediate, toolResult]))).toBeNull();
    const final = assistant([{ type: 'text', text: 'final' }]);
    expect(await extractLastAssistantFromTranscript(transcript([user('p'), intermediate, toolResult, final]))).toBe('final');
  });

  it('extrai a resposta da transcrição real do Claude', async () => {
    const path = fileURLToPath(new URL('../fixtures/claude/transcript.jsonl', import.meta.url));
    expect(await extractLastAssistantFromTranscript(path)).toBe('81');
  });

  it('devolve null sem mensagem do assistente ou com arquivo ausente', async () => {
    expect(await extractLastAssistantFromTranscript(transcript([JSON.stringify({ type: 'user' })]))).toBeNull();
    expect(await extractLastAssistantFromTranscript('C:/nao/existe.jsonl')).toBeNull();
  });
});
