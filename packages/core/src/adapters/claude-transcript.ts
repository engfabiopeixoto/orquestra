import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const textBlock = z.object({ type: z.literal('text'), text: z.string() });
const toolUseBlock = z.object({ type: z.literal('tool_use') });
const line = z.object({
  message: z.object({ role: z.enum(['user', 'assistant']), content: z.union([z.string(), z.array(z.unknown())]) }),
});

// Prompt do usuário tem texto; linha "user" só com tool_result é resultado de ferramenta e não abre turno.
function isUserPrompt(content: string | unknown[]): boolean {
  return typeof content === 'string' || content.some((block) => textBlock.safeParse(block).success);
}

export async function readClaudeTranscript(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let latest: string | null = null;
  for (const text of raw.split(/\r?\n/)) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const parsed = line.safeParse(json);
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
      const parsedBlock = textBlock.safeParse(block);
      return parsedBlock.success ? [parsedBlock.data.text] : [];
    });
    if (texts.length > 0) latest = texts.join('');
  }
  return latest;
}
