import { z } from 'zod';
import { errorCodeSchema, OrqError } from './errors.js';
import { terminalNameSchema } from './names.js';
import { personaScopeSchema } from './regent.js';
import { browserMethodSchemas, browserNodeSchema } from './browser.js';

export const PROTOCOL_VERSION = 1;

export const sessionStateSchema = z.enum(['starting', 'idle', 'busy', 'waiting', 'exited']);
export type SessionState = z.infer<typeof sessionStateSchema>;

const empty = z.object({});
const answered = z.object({ status: z.literal('answered'), askId: z.string(), answer: z.string() });
const pending = z.object({ status: z.literal('pending'), askId: z.string() });

export const methodSchemas = {
  ...browserMethodSchemas,
  whoami: { params: empty, result: z.object({ name: z.string(), agent: z.string() }) },
  peers: {
    params: empty,
    result: z.object({
      peers: z.array(z.object({ name: z.string(), agent: z.string(), state: sessionStateSchema, queued: z.number().int() })),
      portals: z.array(browserNodeSchema).optional(),
    }),
  },
  prompt: {
    params: z.object({ target: z.string().min(1), text: z.string().min(1), timeoutMs: z.number().int().positive() }),
    result: z.discriminatedUnion('status', [answered, pending]),
  },
  result: {
    params: z.object({ askId: z.string().min(1) }),
    result: z.discriminatedUnion('status', [
      z.object({ status: z.literal('answered'), answer: z.string() }),
      z.object({ status: z.literal('pending') }),
      z.object({ status: z.literal('failed'), reason: z.string() }),
    ]),
  },
  read: {
    params: z.object({ target: z.string().min(1), lines: z.number().int().positive().optional() }),
    result: z.object({ text: z.string() }),
  },
  'note.list': {
    params: empty,
    result: z.object({ notes: z.array(z.object({ name: z.string(), revision: z.number().int() })) }),
  },
  'note.show': {
    params: z.object({ name: z.string().min(1) }),
    result: z.object({ name: z.string(), content: z.string(), revision: z.number().int() }),
  },
  'note.write': {
    params: z.object({ name: z.string().min(1), content: z.string() }),
    result: z.object({ name: z.string(), revision: z.number().int(), created: z.boolean() }),
  },
  'note.append': {
    params: z.object({ name: z.string().min(1), content: z.string() }),
    result: z.object({ name: z.string(), revision: z.number().int() }),
  },
  hook: {
    params: z.object({ agent: z.string(), event: z.string(), payload: z.unknown() }),
    result: empty,
  },
  'regent.new': {
    params: z.object({
      name: terminalNameSchema,
      agent: z.enum(['claude', 'agy', 'codex', 'shell']),
      persona: z.string().min(1).optional(),
      args: z.array(z.string()).optional(),
      cwd: z.string().min(1).optional(),
      resume: z.boolean().optional(),
    }),
    result: z.object({ name: z.string() }),
  },
  'regent.remove': {
    params: z.object({ name: z.string().min(1) }),
    result: empty,
  },
  'regent.link': {
    params: z.object({ a: z.string().min(1), b: z.string().min(1) }),
    result: empty,
  },
  'regent.unlink': {
    params: z.object({ a: z.string().min(1), b: z.string().min(1) }),
    result: empty,
  },
  'regent.brief': {
    params: z.object({ target: z.string().min(1), persona: z.string().min(1) }),
    result: empty,
  },
  'persona.list': {
    params: empty,
    result: z.object({ personas: z.array(z.object({ name: z.string(), scope: personaScopeSchema })) }),
  },
  'persona.show': {
    params: z.object({ name: z.string().min(1) }),
    result: z.object({ name: z.string(), scope: personaScopeSchema, text: z.string() }),
  },
  'persona.write': {
    params: z.object({ name: terminalNameSchema, text: z.string(), global: z.boolean() }),
    result: z.object({ name: z.string(), scope: personaScopeSchema, created: z.boolean() }),
  },
  'persona.remove': {
    params: z.object({ name: z.string().min(1), global: z.boolean() }),
    result: empty,
  },
} as const;

export type MethodName = keyof typeof methodSchemas;
export type Params<M extends MethodName> = z.infer<(typeof methodSchemas)[M]['params']>;
export type Result<M extends MethodName> = z.infer<(typeof methodSchemas)[M]['result']>;

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(methodSchemas, name);
}

export function parseParams<M extends MethodName>(method: M, params: unknown): Params<M> {
  const parsed = methodSchemas[method].params.safeParse(params);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; ');
    throw new OrqError('USAGE', `Parâmetros inválidos para ${method}: ${detail}.`);
  }
  return parsed.data as Params<M>;
}

export function parseResult<M extends MethodName>(method: M, result: unknown): Result<M> {
  return methodSchemas[method].result.parse(result) as Result<M>;
}

export const requestSchema = z.object({
  v: z.number().int(),
  id: z.string(),
  token: z.string(),
  method: z.string(),
  params: z.unknown(),
});
export type Request = z.infer<typeof requestSchema>;

export const responseSchema = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: z.object({ code: errorCodeSchema, message: z.string() }) }),
]);
export type Response = z.infer<typeof responseSchema>;
