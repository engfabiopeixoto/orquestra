import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const textBlock = z.object({ type: z.literal('text'), text: z.string() });
const toolUseBlock = z.object({ type: z.literal('tool_use') });
const transcriptLine = z.object({
  message: z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(z.unknown())]) }),
});

// Um prompt do usuário tem texto; uma linha "user" só com tool_result é resultado de ferramenta e não abre turno.
function isUserPrompt(content: string | unknown[]): boolean {
  if (typeof content === 'string') return true;
  return content.some((block) => textBlock.safeParse(block).success);
}

/**
 * Resposta final do turno atual: a última mensagem do assistente com texto e sem tool_use,
 * depois do último prompt do usuário. Null se o turno atual ainda não tem resposta final.
 */
export async function extractLastAssistantFromTranscript(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let latest: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = transcriptLine.safeParse(json);
    if (!parsed.success) continue;
    const { role, content } = parsed.data.message;
    if (role === 'user') {
      if (isUserPrompt(content)) latest = null;
      continue;
    }
    if (typeof content === 'string') {
      latest = content;
      continue;
    }
    if (content.some((block) => toolUseBlock.safeParse(block).success)) continue;
    const texts = content.flatMap((block) => {
      const text = textBlock.safeParse(block);
      return text.success ? [text.data.text] : [];
    });
    if (texts.length > 0) latest = texts.join('');
  }
  return latest;
}
