import { z } from 'zod';
import { OrqError } from './errors.js';
import { terminalNameSchema } from './names.js';
import { personaSchema } from './regent.js';
import { flowGraphSchema, type FlowGraph } from './flow.js';
import { browserNodeSchema } from './browser.js';

export const WORKSPACE_DIR = '.orquestra';
export const WORKSPACE_FILE = 'workspace.json';

const finite = z.number().finite();
export const positionSchema = z.object({ x: finite, y: finite });
export const sizeSchema = z.object({ width: finite.positive(), height: finite.positive() });
export const viewportSchema = z.object({ x: finite, y: finite, zoom: finite.positive() });
export const groupMemberSchema = z.object({ kind: z.enum(['terminal', 'note', 'flow']), id: z.string().uuid() });
export const groupKindSchema = z.enum(['agents', 'notes', 'mixed']);
export const groupColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Escolha uma cor hexadecimal válida.');
export const canvasGroupSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(120), color: groupColorSchema,
  kind: groupKindSchema, position: positionSchema, size: sizeSchema,
  members: z.array(groupMemberSchema), locked: z.boolean().default(false), order: z.number().int().nonnegative(),
});
export type GroupMember = z.infer<typeof groupMemberSchema>;
export type CanvasGroup = z.infer<typeof canvasGroupSchema>;
export const workspaceAgentSchema = z.enum(['claude', 'agy', 'codex', 'shell']);

export const defaultMonitor = (agent: string): boolean => agent === 'claude' || agent === 'agy' || agent === 'codex';

export const workspaceTerminalSchema = z.object({
  id: z.string().uuid(),
  name: terminalNameSchema,
  agent: workspaceAgentSchema,
  cwd: z.string().min(1),
  args: z.array(z.string()),
  resume: z.boolean(),
  regente: z.boolean().default(false),
  persona: z.string().nullable().default(null),
  monitor: z.boolean().optional(),
  unloaded: z.boolean().optional(),
  blurred: z.boolean().optional(),
  locked: z.boolean().optional(),
  agentSessionId: z.string().min(1).nullable(),
  position: positionSchema,
  size: sizeSchema,
});

// Nome de nota segue o orq (qualquer texto não vazio): uma nota criada por agente pode ter espaço.
export const workspaceNoteSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  content: z.string(),
  revision: z.number().int().min(1),
  updatedBy: z.string().min(1),
  position: positionSchema,
  size: sizeSchema,
});

export const connectionSchema = z.object({ a: z.string().min(1), b: z.string().min(1) });

export const workspaceSchema = z
  .object({
    schemaVersion: z.literal(1),
    viewport: viewportSchema,
    terminals: z.array(workspaceTerminalSchema),
    notes: z.array(workspaceNoteSchema),
    connections: z.array(connectionSchema),
    personas: z.array(personaSchema).default([]),
    groups: z.array(canvasGroupSchema).default([]),
    flow: flowGraphSchema.default({ nodes: [], connections: [], autoRun: false }),
    portals: z.array(browserNodeSchema).max(2).default([]),
  })
  .superRefine((workspace, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const kinds = new Map<string, 'terminal' | 'note' | 'portal'>();
    for (const portal of workspace.portals) { if (kinds.has(portal.id)) issue(['portals'], 'Portal repetido.'); kinds.set(portal.id, 'portal'); }
    const ids = new Set<string>();
    const nodes = [
      ...workspace.terminals.map((node, index) => ({ node, kind: 'terminal' as const, path: ['terminals', index] })),
      ...workspace.notes.map((node, index) => ({ node, kind: 'note' as const, path: ['notes', index] })),
    ];
    for (const { node, kind, path } of nodes) {
      if (kinds.has(node.name)) issue([...path, 'name'], `nome repetido: ${node.name}`);
      else kinds.set(node.name, kind);
      if (ids.has(node.id)) issue([...path, 'id'], `id repetido: ${node.id}`);
      else ids.add(node.id);
    }
    const seen = new Set<string>();
    workspace.connections.forEach(({ a, b }, index) => {
      const path = ['connections', index];
      const missing = [a, b].find((name) => !kinds.has(name));
      if (missing) return issue(path, `conexão com nó inexistente: ${missing}`);
      if (a === b) return issue(path, `conexão do nó com ele mesmo: ${a}`);
      if (kinds.get(a) === 'note' && kinds.get(b) === 'note') return issue(path, `conexão entre duas notas: ${a} e ${b}`);
      if ((kinds.get(a) === 'portal' && kinds.get(b) !== 'terminal') || (kinds.get(b) === 'portal' && kinds.get(a) !== 'terminal')) return issue(path, 'Navegadores conectam somente a terminais.');
      const key = [a, b].sort().join('\u0000');
      if (seen.has(key)) return issue(path, `conexão repetida: ${a} e ${b}`);
      seen.add(key);
    });
    const personaNames = new Set<string>();
    workspace.personas.forEach((persona, index) => {
      if (personaNames.has(persona.name)) issue(['personas', index, 'name'], `função repetida: ${persona.name}`);
      personaNames.add(persona.name);
    });
    const groupIds = new Set<string>();
    const membership = new Set<string>();
    workspace.groups.forEach((group, index) => {
      if (groupIds.has(group.id) || ids.has(group.id)) issue(['groups', index, 'id'], 'id de grupo repetido');
      groupIds.add(group.id);
      group.members.forEach((member, memberIndex) => {
        const source = member.kind === 'terminal' ? workspace.terminals : member.kind === 'note' ? workspace.notes : workspace.flow.nodes.filter((node) => node.kind !== 'agent');
        if (!source.some((node) => node.id === member.id)) issue(['groups', index, 'members', memberIndex], 'membro inexistente');
        if (membership.has(member.id)) issue(['groups', index, 'members', memberIndex], 'elemento pertence a mais de um grupo');
        membership.add(member.id);
      });
    });
  });

export type Position = z.infer<typeof positionSchema>;
export type Size = z.infer<typeof sizeSchema>;
export type Viewport = z.infer<typeof viewportSchema>;
export type WorkspaceTerminal = Omit<z.infer<typeof workspaceTerminalSchema>, 'monitor'> & { monitor: boolean };
export type WorkspaceNote = z.infer<typeof workspaceNoteSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type Workspace = Omit<z.infer<typeof workspaceSchema>, 'terminals' | 'groups' | 'flow' | 'portals'> & { terminals: WorkspaceTerminal[]; groups?: CanvasGroup[]; flow?: FlowGraph; portals?: z.infer<typeof browserNodeSchema>[] };

export function emptyWorkspace(): Workspace {
  return { schemaVersion: 1, viewport: { x: 0, y: 0, zoom: 1 }, terminals: [], notes: [], connections: [], personas: [], groups: [], flow: { nodes: [], connections: [], autoRun: false }, portals: [] };
}

export function migrateWorkspace(raw: unknown): Workspace {
  const version = typeof raw === 'object' && raw !== null ? (raw as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version !== 1) throw new OrqError('USAGE', `Workspace inválido: schemaVersion: versão ${String(version)} não suportada (esperada 1).`);
  const parsed = workspaceSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'workspace'}: ${issue.message}`).join('; ');
    throw new OrqError('USAGE', `Workspace inválido: ${detail}.`);
  }
  return {
    ...parsed.data,
    terminals: parsed.data.terminals.map((terminal) => ({
      ...terminal,
      monitor: terminal.monitor ?? defaultMonitor(terminal.agent),
    })),
  };
}
