import { z } from 'zod';
import { errorCodeSchema } from './errors.js';

export const REMOTE_DEFAULT_PORT = 47820;
export const REMOTE_DEV_PORT = 47821;
export const REMOTE_MAX_MESSAGE_BYTES = 64 * 1024;
export const REMOTE_AUTH_TIMEOUT_MS = 5_000;
export const REMOTE_PAIR_TTL_MS = 5 * 60_000;
export const REMOTE_PAIR_RATE_LIMIT = 5;
export const REMOTE_PAIR_RATE_WINDOW_MS = 60_000;

/**
 * Métodos do host permitidos a clientes móveis na Fase 1.
 * `terminal.send` fica para a Fase 2 e é recusado nesta fase.
 */
export const REMOTE_ALLOWED_METHODS = [
  'workspace.list',
  'workspace.activate',
  'terminal.snapshot',
  'models.catalog',
  'usage.claude',
  'usage.codex',
  'usage.agy',
  'terminal.input',
  'prompt.cancel',
  'terminal.restart',
  'terminal.unload',
  'terminal.model',
] as const;

export type RemoteAllowedMethod = (typeof REMOTE_ALLOWED_METHODS)[number];

const REMOTE_ALLOWED_SET = new Set<string>(REMOTE_ALLOWED_METHODS);

export function isRemoteAllowedMethod(method: string): method is RemoteAllowedMethod {
  return REMOTE_ALLOWED_SET.has(method);
}

/**
 * Allowlist explícita de `HostEvent.type` repassados ao controle remoto.
 * Eventos internos de notas, fluxos, grupos e arestas não atravessam o gateway.
 */
export const REMOTE_ALLOWED_EVENTS = [
  'terminal.state',
  'terminal.queue',
  'terminal.turn',
  'terminal.model',
  'terminal.added',
  'terminal.replaced',
  'terminal.removed',
  'terminal.notice',
  'notice',
  'workspace.activated',
  'models.catalog',
  'terminal.output',
] as const;

export type RemoteAllowedEvent = (typeof REMOTE_ALLOWED_EVENTS)[number];

const REMOTE_ALLOWED_EVENT_SET = new Set<string>(REMOTE_ALLOWED_EVENTS);

export function isRemoteAllowedEvent(type: string): type is RemoteAllowedEvent {
  return REMOTE_ALLOWED_EVENT_SET.has(type);
}

export const remoteDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
export type RemoteDevice = z.infer<typeof remoteDeviceSchema>;

export const remoteStatusSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().positive(),
  localUrl: z.string(),
  devicesCount: z.number().int().nonnegative(),
});
export type RemoteStatus = z.infer<typeof remoteStatusSchema>;

export const remotePairResultSchema = z.object({
  token: z.string().min(1),
  url: z.string(),
  expiresAt: z.string(),
});
export type RemotePairResult = z.infer<typeof remotePairResultSchema>;

export const remotePairRequestSchema = z.object({
  pairToken: z.string().trim().min(1, 'Informe o código de pareamento.'),
  deviceName: z.string().trim().min(1, 'Informe o nome do dispositivo.').max(60, 'Nome muito longo.'),
});
export type RemotePairRequest = z.infer<typeof remotePairRequestSchema>;

export const remotePairResponseSchema = z.object({
  deviceToken: z.string().min(1),
  device: remoteDeviceSchema,
});
export type RemotePairResponse = z.infer<typeof remotePairResponseSchema>;

export const remoteClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1) }),
  z.object({
    type: z.literal('command'),
    id: z.string().min(1).max(128),
    method: z.string().min(1),
    params: z.unknown(),
    workspaceId: z.string().optional(),
  }),
]);
export type RemoteClientMessage = z.infer<typeof remoteClientMessageSchema>;

export const remoteErrorPayloadSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
});
export type RemoteErrorPayload = z.infer<typeof remoteErrorPayloadSchema>;
