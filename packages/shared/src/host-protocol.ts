import { z } from 'zod';
import { settingsSchema } from './args.js';
import { errorCodeSchema, OrqError } from './errors.js';
import { terminalNameSchema } from './names.js';
import { sessionStateSchema } from './protocol.js';
import { personaScopeSchema } from './regent.js';
import { canvasGroupSchema, groupColorSchema, groupKindSchema, groupMemberSchema, positionSchema, sizeSchema, viewportSchema } from './workspace.js';
import { browserNodeSchema, browserMethodSchemas } from './browser.js';
import { modelAgentSchema, modelCatalogSchema, modelNameSchema, terminalModelSchema } from './models.js';
import { remoteDeviceSchema, remoteErrorPayloadSchema, remotePairResultSchema, remoteStatusSchema } from './remote.js';

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
  /** Ausente no shell, que não tem modelo. */
  model: terminalModelSchema.optional(),
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
import { subscriptionUsageSchema, usageProviderSchema, type SubscriptionUsage } from './usage-schema.js';
export { subscriptionUsageSchema, usageProviderSchema, type SubscriptionUsage, type UsageProvider } from './usage-schema.js';
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
});
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

export const workspaceInfoSchema = z.object({
  id: z.string(), dir: z.string(), name: z.string(),
  status: z.enum(['paused', 'opening', 'open', 'closing']),
  terminalCount: z.number().int().nonnegative(), busy: z.number().int().nonnegative(), waiting: z.number().int().nonnegative(),
});
export type WorkspaceInfo = z.infer<typeof workspaceInfoSchema>;

export const TERMINAL_SEND_MAX_CHARS = 16 * 1024;
export const terminalKeySchema = z.enum(['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'CtrlC', 'Digit1', 'Digit2', 'Digit3']);
export type TerminalKey = z.infer<typeof terminalKeySchema>;

export const hostMethodSchemas = {
  'portal.register': { params: browserNodeSchema, result: empty },
  'portal.registry': { params: empty, result: z.object({ portals: z.array(browserNodeSchema) }) },
  'portal.unregister': { params: z.object({ id: z.string().min(1) }), result: empty },
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
  'models.catalog': { params: empty, result: modelCatalogSchema },
  'models.refresh': { params: z.object({ agent: modelAgentSchema.optional() }), result: modelCatalogSchema },
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
  /** Troca o modelo com o /model do agente, sem reiniciar, e guarda a escolha para os próximos lançamentos. */
  'terminal.model': { params: z.object({ name: z.string().min(1), model: modelNameSchema }), result: terminalInfoSchema },
  'terminal.rename': { params: z.object({ name: z.string().min(1), newName: terminalNameSchema }), result: terminalInfoSchema },
  'terminal.input': { params: z.object({ name: z.string().min(1), data: z.string() }), result: empty },
  // Mensagem do celular: cola o texto como o desktop colaria e envia Enter.
  'terminal.send': { params: z.object({ name: z.string().min(1), text: z.string().min(1).max(TERMINAL_SEND_MAX_CHARS, 'Mensagem acima de 16 KB.') }), result: empty },
  // Tecla nomeada: o núcleo escolhe o formato que o agente entende (VT comum ou Win32 do Codex).
  'terminal.key': { params: z.object({ name: z.string().min(1), key: terminalKeySchema }), result: empty },
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
  'remote.status': {
    params: empty,
    result: remoteStatusSchema,
  },
  'remote.enable': {
    params: z.object({ enabled: z.boolean(), fallbackHttp: z.boolean().optional() }),
    result: remoteStatusSchema,
  },
  'remote.pair': {
    params: empty,
    result: remotePairResultSchema,
  },
  'remote.devices': {
    params: empty,
    result: z.object({ devices: z.array(remoteDeviceSchema) }),
  },
  'remote.revoke': {
    params: z.object({ id: z.string().min(1) }),
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
  z.object({ type: z.literal('group.layout'), groups: z.array(canvasGroupSchema), layout: z.record(rectSchema) }),
  z.object({ type: z.literal('terminal.output'), name: z.string(), data: z.string() }),
  z.object({ type: z.literal('terminal.state'), name: z.string(), state: sessionStateSchema, queued: z.number().int() }),
  z.object({ type: z.literal('terminal.queue'), name: z.string(), entries: z.array(queueEntrySchema) }),
  z.object({ type: z.literal('ask.answered'), askId: z.string(), from: z.string(), target: z.string() }),
  z.object({ type: z.literal('terminal.removed'), name: z.string() }),
  z.object({ type: z.literal('terminal.notice'), name: z.string(), message: z.string() }),
  z.object({ type: z.literal('terminal.model'), name: z.string(), model: terminalModelSchema }),
  z.object({ type: z.literal('models.catalog'), catalog: modelCatalogSchema }),
  z.object({ type: z.literal('usage.updated'), provider: usageProviderSchema, usage: subscriptionUsageSchema }),
  z.object({ type: z.literal('notice'), level: z.enum(['info', 'warn', 'error']), message: z.string() }),
  // connectedTo e rect vêm preenchidos quando a nota nasceu de um agente.
  z.object({ type: z.literal('note.changed'), note: noteInfoSchema, connectedTo: z.string().nullable(), rect: rectSchema.nullable(), renamedFrom: z.string().optional() }),
  z.object({ type: z.literal('terminal.added'), info: terminalInfoSchema, rect: rectSchema, connectedTo: z.string().nullable() }),
  z.object({ type: z.literal('terminal.replaced'), info: terminalInfoSchema, oldName: z.string().optional() }),
  z.object({ type: z.literal('workspace.activated'), workspaceId: z.string() }),
  z.object({ type: z.literal('edge.added'), a: z.string(), b: z.string() }),
  z.object({ type: z.literal('edge.removed'), a: z.string(), b: z.string() }),
  z.object({ type: z.literal('note.removed'), name: z.string() }),
  z.object({ type: z.literal('terminal.turn'), name: z.string(), owner: z.enum(['user', 'broker']), outcome: z.enum(['ended', 'failed']) }),
]).and(z.object({ workspaceId: z.string().optional(), sequence: z.number().int().nonnegative().optional() }));
export type HostEvent = z.infer<typeof hostEventSchema>;

export const remoteServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth-ok'), device: remoteDeviceSchema }),
  z.object({ type: z.literal('auth-error'), error: remoteErrorPayloadSchema }),
  z.object({ type: z.literal('response'), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal('response-error'), id: z.string(), error: remoteErrorPayloadSchema }),
  z.object({ type: z.literal('event'), event: hostEventSchema }),
  z.object({ type: z.literal('error'), error: remoteErrorPayloadSchema }),
  // A saída acumulada passou do limite e foi descartada: o cliente pede um terminal.snapshot novo.
  z.object({ type: z.literal('output-overflow'), name: z.string(), workspaceId: z.string().optional() }),
]);
export type RemoteServerMessage = z.infer<typeof remoteServerMessageSchema>;

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
