import { z } from 'zod';

/** Agentes que têm modelo escolhível (o shell não tem). */
export const modelAgentSchema = z.enum(['claude', 'agy', 'codex']);
export type ModelAgent = z.infer<typeof modelAgentSchema>;

export const isModelAgent = (agent: string): agent is ModelAgent => modelAgentSchema.safeParse(agent).success;

// Vai para o argv do CLI e é digitado no terminal: sem espaços nem aspas.
export const modelNameSchema = z
  .string()
  .trim()
  .min(1, 'Informe o nome do modelo.')
  .max(100, 'Use até 100 caracteres no nome do modelo.')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/, 'Use só letras, números, ponto, hífen, dois-pontos, barra e colchetes no nome do modelo.');

export const modelOptionSchema = z.object({
  id: modelNameSchema,
  label: z.string().trim().min(1),
});
export type ModelOption = z.infer<typeof modelOptionSchema>;

export const agentModelCatalogSchema = z.object({
  agent: modelAgentSchema,
  source: z.enum(['cli', 'builtin']),
  cliVersion: z.string().min(1).nullable(),
  fetchedAt: z.string().datetime({ offset: true }).nullable(),
  models: z.array(modelOptionSchema).min(1),
});
export type AgentModelCatalog = z.infer<typeof agentModelCatalogSchema>;

export const modelCatalogSchema = z.object({
  claude: agentModelCatalogSchema.refine((entry) => entry.agent === 'claude', 'Agente inválido para claude.'),
  agy: agentModelCatalogSchema.refine((entry) => entry.agent === 'agy', 'Agente inválido para agy.'),
  codex: agentModelCatalogSchema.refine((entry) => entry.agent === 'codex', 'Agente inválido para codex.'),
});
export type ModelCatalog = Record<ModelAgent, AgentModelCatalog>;

/**
 * Lista fixa mantida no Orquestra, conferida em 17/11/2026: `claude --help` e catálogo do `/model` (Claude Code 2.1.327),
 * ~/.codex/models_cache.json (modelos visíveis do codex-cli 0.167.0) e `agy models` (agy 1.5.10). Outro nome pode ser digitado no menu.
 */
export const AGENT_MODELS: Record<ModelAgent, readonly ModelOption[]> = {
  claude: [
    { id: 'fable', label: 'Fable (mais recente)' },
    { id: 'opus', label: 'Opus (mais recente)' },
    { id: 'sonnet', label: 'Sonnet (mais recente)' },
    { id: 'haiku', label: 'Haiku (mais recente)' },
    { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  ],
  codex: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
  ],
  agy: [
    { id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)' },
    { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)' },
    { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)' },
    { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
    { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
    { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
    { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
    { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
    { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
    { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
    { id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' },
    { id: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ],
};

export function builtinModelCatalog(): ModelCatalog {
  return {
    claude: { agent: 'claude', source: 'builtin', cliVersion: null, fetchedAt: null, models: AGENT_MODELS.claude.map((option) => ({ ...option })) },
    agy: { agent: 'agy', source: 'builtin', cliVersion: null, fetchedAt: null, models: AGENT_MODELS.agy.map((option) => ({ ...option })) },
    codex: { agent: 'codex', source: 'builtin', cliVersion: null, fetchedAt: null, models: AGENT_MODELS.codex.map((option) => ({ ...option })) },
  };
}

/** Comando que troca o modelo sem reiniciar: os três CLIs aceitam o nome direto, sem abrir o seletor. */
export const modelCommand = (model: string): string => `/model ${model}`;

// Alias do Claude Code -> famílias do id completo que ele pode resolver.
const CLAUDE_ALIASES: Record<string, string[]> = {
  opus: ['opus'],
  sonnet: ['sonnet'],
  haiku: ['haiku'],
  fable: ['fable'],
  opusplan: ['opus', 'sonnet'],
  best: ['fable', 'opus'],
};

const normalize = (model: string) => model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
const modelSlug = (model: string) => model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Id do agy para um nome de exibição da lista ("Gemini 3.8 Flash (Medium)"); nome desconhecido volta igual. */
export function agyModelId(label: string, options: readonly ModelOption[] = AGENT_MODELS.agy): string {
  const wanted = modelSlug(label);
  return options.find((option) => modelSlug(option.label) === wanted || modelSlug(option.id) === wanted)?.id ?? label.trim();
}

/** O modelo que o agente informa corresponde ao escolhido? Aceita alias do Claude e sufixo de data no id. */
export function sameModel(agent: ModelAgent, chosen: string, effective: string, agyOptions?: readonly ModelOption[]): boolean {
  const wanted = normalize(chosen);
  const used = normalize(effective);
  if (wanted === used) return true;
  if (used.startsWith(`${wanted}-`) && /^\d{8}$/.test(used.slice(wanted.length + 1))) return true;
  // O agy guarda o nome de exibição ("Gemini 4 Carbon (Medium)") e o hook e a flag usam o id (gemini-4-carbon-medium).
  if (agent === 'agy') return modelSlug(agyModelId(chosen, agyOptions)) === modelSlug(agyModelId(effective, agyOptions));
  if (agent !== 'claude') return false;
  if (wanted === 'default') return true;
  const families = CLAUDE_ALIASES[wanted];
  return Boolean(families?.some((family) => used === `claude-${family}` || used.startsWith(`claude-${family}-`)));
}

/**
 * unset: sem modelo escolhido. unknown: o agente ainda não informou o modelo. pending: a última informação é de
 * antes da escolha (a confirmação vem no próximo turno). match/mismatch: comparação com o modelo informado.
 */
export const modelStatusSchema = z.enum(['unset', 'unknown', 'pending', 'match', 'mismatch']);
export type ModelStatus = z.infer<typeof modelStatusSchema>;

export const terminalModelSchema = z.object({
  chosen: z.string().nullable(),
  effective: z.string().nullable(),
  status: modelStatusSchema,
});
export type TerminalModel = z.infer<typeof terminalModelSchema>;

export type ModelObservation = { model: string; at: number };

export function terminalModel(agent: ModelAgent, chosen: string | null, chosenAt: number, observed: ModelObservation | null, agyOptions?: readonly ModelOption[]): TerminalModel {
  const effective = observed?.model ?? null;
  if (chosen === null) return { chosen, effective, status: 'unset' };
  if (!observed) return { chosen, effective, status: 'unknown' };
  if (observed.at < chosenAt) return { chosen, effective, status: 'pending' };
  return { chosen, effective, status: sameModel(agent, chosen, observed.model, agyOptions) ? 'match' : 'mismatch' };
}
