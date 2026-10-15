import { z } from 'zod';
import { settingsSchema } from './args.js';
import { errorCodeSchema, OrqError } from './errors.js';
import { terminalNameSchema } from './names.js';
import { sessionStateSchema } from './protocol.js';
import { personaScopeSchema } from './regent.js';
import { canvasGroupSchema, groupColorSchema, groupKindSchema, groupMemberSchema, positionSchema, sizeSchema, viewportSchema } from './workspace.js';
import { flowGraphSchema, flowNodeSchema, flowRunSchema, flowNodeResultSchema, flowSnapshotSchema, flowTestReportSchema, jsonValueSchema } from './flow.js';
import { browserNodeSchema, browserMethodSchemas } from './browser.js';

export { terminalNameSchema } from './names.js';

export const rectSchema = positionSchema.merge(sizeSchema);

export const noteInfoSchema = z.object({ id: z.string().uuid().optional(), name: z.string(), content: z.string(), revision: z.number().int(), updatedBy: z.string() });
export type NoteInfo = z.infer<typeof noteInfoSchema>;

export const hostAgentSchema = z.enum(['claude', 'agy', 'codex', 'shell']);
export type HostAgent = z.infer<typeof hostAgentSchema>;

export const terminalInfoSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string(),
  agent: z.string(),
  state: sessionStateSchema,
  queued: z.number().int(),
  cwd: z.string(),
  resume: z.boolean(),
  args: z.array(z.string()),
  regente: z.boolean(),
  monitor: z.boolean(),
  unloaded: z.boolean().optional(),
  blurred: z.boolean().optional(),
  locked: z.boolean().optional(),
});
export type TerminalInfo = z.infer<typeof terminalInfoSchema>;

export const queueEntrySchema = z.object({
  askId: z.string(),
  from: z.string(),
  preview: z.string(),
  status: z.enum(['queued', 'running']),
  kind: z.enum(['prompt', 'delivery']),
});
export type QueueEntry = z.infer<typeof queueEntrySchema>;

/** Arquivo, na pasta de dados, com os PIDs dos agentes vivos: o principal os encerra se o núcleo cair. */
export const AGENT_PID_FILE = 'agentes-ativos.json';

const empty = z.object({});
const edgeSchema = z.object({ a: z.string(), b: z.string() });
const named = z.object({ name: z.string().min(1) });
const groupNamed = z.object({ id: z.string().uuid() });
const groupAssignmentSchema = z.object({ member: groupMemberSchema, groupId: z.string().uuid().nullable() });
export const groupLayoutSchema = z.object({ groups: z.array(canvasGroupSchema), layout: z.record(rectSchema) });
export type GroupLayout = z.infer<typeof groupLayoutSchema>;
export const subscriptionUsageSchema = z.object({
  checkedAt: z.string(),
  windows: z.array(z.object({ label: z.string(), usedPercent: z.number().finite().min(0).max(100), resetsAt: z.string().nullable() })),
  credits: z.string().nullable(),
  details: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
});
export const projectFileSchema = z.object({
  name: z.string(), path: z.string(), kind: z.enum(['directory', 'file', 'link']),
  change: z.enum(['none', 'added', 'modified', 'removed']),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

/** Estado vivo do projeto: reabrir a mesma pasta (interface recarregada) o devolve em vez de encerrar os terminais. */
export const projectSnapshotSchema = z.object({
  workspaceId: z.string().optional(),
  eventSequence: z.number().int().nonnegative().optional(),
  dir: z.string(),
  name: z.string(),
  terminals: z.array(terminalInfoSchema),
  notes: z.array(noteInfoSchema),
  edges: z.array(edgeSchema),
  layout: z.record(rectSchema),
  viewport: viewportSchema,
  queues: z.record(z.array(queueEntrySchema)).optional(),
  groups: z.array(canvasGroupSchema).optional(),
  flow: flowSnapshotSchema.optional(),
});
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

export const workspaceInfoSchema = z.object({
  id: z.string(), dir: z.string(), name: z.string(),
  status: z.enum(['paused', 'opening', 'open', 'closing']),
  terminalCount: z.number().int().nonnegative(), busy: z.number().int().nonnegative(), waiting: z.number().int().nonnegative(),
});
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

export const hostMethodSchemas = {
  'portal.register': { params: browserNodeSchema, result: empty },
  'portal.registry': { params: empty, result: z.object({ portals: z.array(browserNodeSchema) }) },
  'portal.unregister': { params: z.object({ id: z.string().min(1) }), result: empty },
  'flow.get': { params: empty, result: flowSnapshotSchema },
  'flow.save': { params: z.object({ node: flowNodeSchema }), result: flowSnapshotSchema },
  'flow.remove': { params: groupNamed, result: flowSnapshotSchema },
  'flow.connect': { params: z.object({ from: z.string().uuid(), output: z.string(), to: z.string().uuid(), input: z.string() }), result: flowSnapshotSchema },
  'flow.disconnect': { params: groupNamed, result: flowSnapshotSchema },
  'flow.move': { params: z.object({ nodes: z.array(groupNamed.extend({ position: positionSchema, size: sizeSchema.optional() })).max(200), groupAssignments: z.array(groupAssignmentSchema).optional() }), result: empty },
  'flow.run': { params: z.object({ targets: z.array(z.string().uuid()).optional(), force: z.boolean().default(false) }), result: flowSnapshotSchema },
  'flow.cancel': { params: empty, result: flowSnapshotSchema },
  'flow.auto': { params: z.object({ enabled: z.boolean() }), result: flowSnapshotSchema },
  'flow.test': { params: groupNamed, result: flowTestReportSchema },
  'flow.example': { params: z.object({ position: positionSchema }), result: flowSnapshotSchema },
  'flow.inspect': { params: z.object({ nodeId: z.string().uuid(), port: z.string(), direction: z.enum(['input', 'output']).default('output'), runId: z.string().uuid().optional() }), result: z.object({ value: jsonValueSchema, bytes: z.number(), revision: z.string(), stale: z.boolean() }) },
  'flow.history': { params: empty, result: z.object({ runs: z.array(flowRunSchema).max(20) }) },
  'flow.compare': { params: z.object({ before: z.string().uuid(), after: z.string().uuid() }), result: z.object({ changes: z.array(z.object({ id: z.string(), title: z.string(), codeChanged: z.boolean(), outputsChanged: z.array(z.string()) })) }) },
  'flow.exportPreview': { params: z.object({ nodeId: z.string().uuid(), port: z.string(), runId: z.string().uuid().optional(), path: z.string() }), result: z.object({ path: z.string(), next: z.string(), previous: z.string().nullable(), previousHash: z.string().nullable(), nextHash: z.string() }) },
  'flow.exportApply': { params: z.object({ nodeId: z.string().uuid(), port: z.string(), runId: z.string().uuid().optional(), path: z.string(), previousHash: z.string().nullable(), nextHash: z.string() }), result: z.object({ path: z.string() }) },
  'group.create': { params: z.object({ title: z.string().trim().min(1).max(120), color: groupColorSchema, kind: groupKindSchema, members: z.array(groupMemberSchema).default([]), position: positionSchema }), result: groupLayoutSchema },
  'group.update': { params: groupNamed.extend({ title: z.string().trim().min(1).max(120).optional(), color: groupColorSchema.optional(), locked: z.boolean().optional() }), result: groupLayoutSchema },
  'group.assign': { params: z.object({ id: z.string().uuid().nullable(), members: z.array(groupMemberSchema) }), result: groupLayoutSchema },
  'group.members': { params: groupNamed.extend({ members: z.array(groupMemberSchema) }), result: groupLayoutSchema },
  'group.move': { params: groupNamed.extend({ position: positionSchema }), result: groupLayoutSchema },
  'group.resize': { params: groupNamed.extend({ rect: rectSchema }), result: groupLayoutSchema },
  'group.fit': { params: groupNamed, result: groupLayoutSchema },
  'group.remove': { params: groupNamed, result: groupLayoutSchema },
  'group.layout': { params: empty, result: groupLayoutSchema },
  'workspace.list': { params: empty, result: z.object({ workspaces: z.array(workspaceInfoSchema).max(3), selectedId: z.string().nullable() }) },
  'workspace.activate': { params: z.object({ id: z.string().min(1) }), result: projectSnapshotSchema },
  'files.list': {
    params: z.object({ path: z.string().default('') }),
    result: z.object({ entries: z.array(projectFileSchema), comparison: z.enum(['git', 'session']), truncated: z.boolean() }),
  },
  'files.read': {
    params: z.object({ path: z.string().min(1) }),
    result: z.object({ path: z.string(), content: z.string().nullable(), diff: z.string().nullable(), kind: z.enum(['text', 'binary', 'large', 'removed']) }),
  },
  'usage.codex': {
    params: empty,
    result: subscriptionUsageSchema,
  },
  'usage.claude': { params: empty, result: subscriptionUsageSchema },
  'usage.agy': { params: empty, result: subscriptionUsageSchema },
  'project.open': { params: z.object({ dir: z.string().min(1) }), result: projectSnapshotSchema },
  'project.close': { params: empty, result: empty },
  'terminal.create': {
    // resume ausente: o núcleo retoma por padrão.
    params: z.object({
      name: terminalNameSchema,
      agent: hostAgentSchema,
      cwd: z.string().min(1).optional(),
      resume: z.boolean().optional(),
      args: z.array(z.string()).optional(),
      regente: z.boolean().optional(),
      persona: z.string().min(1).optional(),
      monitor: z.boolean().optional(),
      groupId: z.string().uuid().optional(),
    }),
    result: terminalInfoSchema,
  },
  'terminal.update': {
    params: z.object({
      name: z.string().min(1),
      newName: terminalNameSchema.optional(),
      cwd: z.string().min(1).optional(),
      args: z.array(z.string()).optional(),
      resume: z.boolean().optional(),
      regente: z.boolean().optional(),
      monitor: z.boolean().optional(),
    }),
    result: terminalInfoSchema,
  },
  'terminal.remove': { params: named, result: empty },
  'terminal.restart': { params: named, result: terminalInfoSchema },
  'terminal.unload': { params: named, result: terminalInfoSchema },
  'terminal.duplicate': { params: named, result: z.object({ info: terminalInfoSchema, rect: rectSchema }) },
  'terminal.presentation': {
    params: z.object({ name: z.string().min(1), blurred: z.boolean().optional(), locked: z.boolean().optional() }),
    result: terminalInfoSchema,
  },
  'terminal.rename': { params: z.object({ name: z.string().min(1), newName: terminalNameSchema }), result: terminalInfoSchema },
  'terminal.input': { params: z.object({ name: z.string().min(1), data: z.string() }), result: empty },
  'terminal.resize': {
    params: z.object({ name: z.string().min(1), cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) }),
    result: empty,
  },
  'terminal.snapshot': { params: named, result: z.object({ data: z.string(), cols: z.number().int(), rows: z.number().int() }) },
  'edge.connect': { params: z.object({ a: z.string().min(1), b: z.string().min(1) }), result: empty },
  'edge.disconnect': { params: z.object({ a: z.string().min(1), b: z.string().min(1) }), result: empty },
  'prompt.cancel': { params: z.object({ askId: z.string().min(1) }), result: z.object({ cancelled: z.boolean(), terminalBusy: z.boolean() }) },
  'layout.update': {
    params: z.object({ nodes: z.array(z.object({ name: z.string().min(1) }).merge(rectSchema)), viewport: viewportSchema.optional(), groupAssignments: z.array(groupAssignmentSchema).optional() }),
    result: empty,
  },
  'note.create': {
    params: z.object({ name: terminalNameSchema, content: z.string().default(''), rect: rectSchema.optional(), groupId: z.string().uuid().optional() }),
    result: noteInfoSchema,
  },
  'note.rename': { params: z.object({ name: z.string().min(1), newName: terminalNameSchema }), result: noteInfoSchema },
  'note.save': {
    // baseRevision: revisão em que a edição começou; null sobrescreve.
    params: z.object({ name: z.string().min(1), content: z.string(), baseRevision: z.number().int().nullable() }),
    result: noteInfoSchema,
  },
  'note.remove': { params: named, result: empty },
  'recent.list': {
    params: empty,
    result: z.object({ projects: z.array(z.object({ dir: z.string(), name: z.string(), openedAt: z.string() })) }),
  },
  'settings.get': {
    params: empty,
    result: settingsSchema,
  },
  'settings.update': {
    params: settingsSchema,
    result: settingsSchema,
  },
  'persona.list': {
    params: empty,
    result: z.object({ personas: z.array(z.object({ name: z.string(), scope: personaScopeSchema, text: z.string() })) }),
  },
  'persona.save': {
    params: z.object({ name: terminalNameSchema, text: z.string(), scope: personaScopeSchema }),
    result: empty,
  },
  'persona.remove': {
    params: z.object({ name: z.string().min(1), scope: personaScopeSchema }),
    result: empty,
  },
} as const;

export type HostMethod = keyof typeof hostMethodSchemas;
export type HostParams<M extends HostMethod> = z.infer<(typeof hostMethodSchemas)[M]['params']>;
export type HostResult<M extends HostMethod> = z.infer<(typeof hostMethodSchemas)[M]['result']>;

export function isHostMethod(name: string): name is HostMethod {
  return Object.hasOwn(hostMethodSchemas, name);
}

export function parseHostParams<M extends HostMethod>(method: M, params: unknown): HostParams<M> {
  const parsed = hostMethodSchemas[method].params.safeParse(params);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; ');
    throw new OrqError('USAGE', `Parâmetros inválidos para ${method}: ${detail}.`);
  }
  return parsed.data as HostParams<M>;
}

export function parseHostResult<M extends HostMethod>(method: M, result: unknown): HostResult<M> {
  return hostMethodSchemas[method].result.parse(result) as HostResult<M>;
}

export const hostEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('flow.graph'), graph: flowGraphSchema, revision: z.string().optional() }),
  z.object({ type: z.literal('flow.run'), run: flowRunSchema }),
  z.object({ type: z.literal('flow.node'), runId: z.string().uuid(), id: z.string().uuid(), result: flowNodeResultSchema }),
  z.object({ type: z.literal('group.layout'), groups: z.array(canvasGroupSchema), layout: z.record(rectSchema) }),
  z.object({ type: z.literal('terminal.output'), name: z.string(), data: z.string() }),
  z.object({ type: z.literal('terminal.state'), name: z.string(), state: sessionStateSchema, queued: z.number().int() }),
  z.object({ type: z.literal('terminal.queue'), name: z.string(), entries: z.array(queueEntrySchema) }),
  z.object({ type: z.literal('ask.answered'), askId: z.string(), from: z.string(), target: z.string() }),
  z.object({ type: z.literal('terminal.removed'), name: z.string() }),
  z.object({ type: z.literal('terminal.notice'), name: z.string(), message: z.string() }),
  z.object({ type: z.literal('notice'), level: z.enum(['info', 'warn', 'error']), message: z.string() }),
  // connectedTo e rect vêm preenchidos quando a nota nasceu de um agente.
  z.object({ type: z.literal('note.changed'), note: noteInfoSchema, connectedTo: z.string().nullable(), rect: rectSchema.nullable(), renamedFrom: z.string().optional() }),
  z.object({ type: z.literal('terminal.added'), info: terminalInfoSchema, rect: rectSchema, connectedTo: z.string().nullable() }),
  z.object({ type: z.literal('edge.added'), a: z.string(), b: z.string() }),
  z.object({ type: z.literal('edge.removed'), a: z.string(), b: z.string() }),
  z.object({ type: z.literal('note.removed'), name: z.string() }),
  z.object({ type: z.literal('terminal.turn'), name: z.string(), owner: z.enum(['user', 'broker']), outcome: z.enum(['ended', 'failed']) }),
]).and(z.object({ workspaceId: z.string().optional(), sequence: z.number().int().nonnegative().optional() }));
export type HostEvent = z.infer<typeof hostEventSchema>;

export const mainToHostSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('portal-reply'), id: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.object({ code: errorCodeSchema, message: z.string() }).optional() }),
  z.object({ kind: z.literal('command'), id: z.string(), method: z.string(), params: z.unknown(), workspaceId: z.string().optional() }),
  z.object({ kind: z.literal('confirm-reply'), id: z.string(), approved: z.boolean() }),
  z.object({ kind: z.literal('shutdown') }),
]);
export type MainToHost = z.infer<typeof mainToHostSchema>;

export const hostToMainSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('portal-cancel'), id: z.string() }),
  z.object({ kind: z.literal('portal-call'), id: z.string(), workspaceId: z.string().optional(), method: z.enum(['portal.check', 'portal.navigate', 'portal.click', 'portal.type', 'portal.scroll', 'portal.screenshot']), params: z.unknown() }),
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('response'), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ kind: z.literal('response-error'), id: z.string(), error: z.object({ code: errorCodeSchema, message: z.string() }) }),
  z.object({ kind: z.literal('event'), event: hostEventSchema }),
  z.object({ kind: z.literal('confirm'), id: z.string(), message: z.string() }),
]);
export type HostToMain = z.infer<typeof hostToMainSchema>;

/** Código de saída do núcleo quando o pipe já está em uso (outro Orquestra ou o harness). */
export const HOST_EXIT_PIPE_BUSY = 3;
