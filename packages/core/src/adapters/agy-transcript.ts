import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const plannerResponse = z.object({
  source: z.literal('MODEL'),
  type: z.literal('PLANNER_RESPONSE'),
  content: z.string(),
  tool_calls: z.array(z.unknown()).optional(),
});
const userInput = z.object({ type: z.literal('USER_INPUT') });

/** Resposta final do turno atual: depois do último USER_INPUT, com texto e sem tool_calls. */
export async function readAgyTranscript(path: string): Promise<string | null> {
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
    if (userInput.safeParse(json).success) {
      latest = null;
      continue;
    }
    const parsed = plannerResponse.safeParse(json);
    if (!parsed.success || parsed.data.content.trim() === '') continue;
    if (parsed.data.tool_calls && parsed.data.tool_calls.length > 0) continue;
    latest = parsed.data.content;
  }
  return latest;
}
