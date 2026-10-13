import { z } from 'zod';

export const browserNodeSchema = z.object({ id: z.string().min(1).max(120), title: z.string().max(240).default('Navegador') });
const target = z.object({ id: z.string().min(1).max(120) });
const result = z.object({ ok: z.literal(true) });
export const browserMethodSchemas = {
  'portal.list': { params: z.object({}), result: z.object({ portals: z.array(browserNodeSchema).max(2) }) },
  'portal.check': { params: target.extend({ maxChars: z.number().int().min(100).max(64000).optional() }), result: z.object({
    id: z.string(), url: z.string(), title: z.string(), text: z.string().max(64000), mode: z.enum(['desktop', 'mobile']), presetId: z.string(),
    elements: z.array(z.object({ selector: z.string(), tag: z.string(), type: z.string(), text: z.string(), placeholder: z.string(), disabled: z.boolean() })).max(150),
  }) },
  'portal.navigate': { params: target.extend({ url: z.string().min(1).max(4096) }), result },
  'portal.click': { params: target.extend({ selector: z.string().min(1).max(1000) }), result },
  'portal.type': { params: target.extend({ selector: z.string().min(1).max(1000), text: z.string().max(20000) }), result },
  'portal.scroll': { params: target.extend({ x: z.number().finite().min(-10000).max(10000).optional(), y: z.number().finite().min(-10000).max(10000) }), result },
  'portal.screenshot': { params: target, result: z.object({ path: z.string(), mimeType: z.literal('image/png') }) },
} as const;
export type BrowserMethod = Exclude<keyof typeof browserMethodSchemas, 'portal.list'>;
export type BrowserParams<M extends BrowserMethod> = z.infer<(typeof browserMethodSchemas)[M]['params']>;
export type BrowserResult<M extends BrowserMethod> = z.infer<(typeof browserMethodSchemas)[M]['result']>;
export type BrowserHandler = <M extends BrowserMethod>(method: M, params: BrowserParams<M>, signal: AbortSignal) => Promise<BrowserResult<M>>;
export type BrowserNode = z.infer<typeof browserNodeSchema>;
