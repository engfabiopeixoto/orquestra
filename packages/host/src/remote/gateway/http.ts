import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@orquestra/core';
import {
  OrqError,
  REMOTE_MAX_MESSAGE_BYTES,
  remotePairRequestSchema,
} from '@orquestra/shared';
import type { RemoteDeviceStore } from '../device-store.js';
import type { OriginCheck, RequestUrlParser } from './types.js';

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/** Resolve o diretório padrão do build do aplicativo móvel a partir do módulo do gateway. */
export function defaultMobileDir(baseUrl: string): string {
  const here = dirname(fileURLToPath(baseUrl));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const envDir = process.env.ORQ_MOBILE_DIR?.trim();
  const candidates = [
    ...(envDir ? [envDir] : []),
    ...(resourcesPath ? [join(resourcesPath, 'mobile')] : []),
    resolve(here, '../mobile'),
    resolve(here, '../../../mobile/dist'),
    resolve(here, '../../mobile/dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return candidates[0]!;
}

/** Envia resposta JSON com cabeçalhos de segurança e sem cache. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** Envia resposta em texto puro com cabeçalhos de segurança e sem cache. */
export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

/** Lê e faz parsing de corpo JSON respeitando o limite máximo de 64 KB. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > REMOTE_MAX_MESSAGE_BYTES) {
      throw new OrqError('USAGE', 'Corpo da requisição excede 64 KB.');
    }
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new OrqError('USAGE', 'JSON inválido.');
  }
}

/** Garante que um caminho real esteja estritamente dentro da raiz estática permitida. */
export function isInsideRoot(realRoot: string, realTarget: string): boolean {
  const rel = relative(realRoot, realTarget);
  if (rel === '') return true;
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

type StaticResolution =
  | { ok: true; filePath: string }
  | { ok: false; status: number; message: string };

function sanitizeStaticPath(pathname: string): { ok: true; stripped: string } | { ok: false; status: number; message: string } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, status: 400, message: 'Caminho inválido.' };
  }
  if (decoded.includes('\0')) return { ok: false, status: 403, message: 'Acesso negado.' };
  const stripped = decoded.replace(/^\/+/, '');
  const segments = stripped.split(/[\\/]+/);
  if (isAbsolute(stripped) || segments.includes('..')) {
    return { ok: false, status: 403, message: 'Acesso negado.' };
  }
  return { ok: true, stripped };
}

function resolveCandidateFile(realRoot: string, candidate: string): StaticResolution {
  if (!existsSync(candidate)) return { ok: true, filePath: join(realRoot, 'index.html') };
  try {
    const realTarget = realpathSync(candidate);
    if (!isInsideRoot(realRoot, realTarget)) return { ok: false, status: 403, message: 'Acesso negado.' };
    const stats = statSync(realTarget);
    if (stats.isDirectory()) return { ok: true, filePath: join(realRoot, 'index.html') };
    if (!stats.isFile()) return { ok: false, status: 403, message: 'Acesso negado.' };
    return { ok: true, filePath: realTarget };
  } catch {
    return { ok: false, status: 403, message: 'Acesso negado.' };
  }
}

function resolveStaticFile(mobileDir: string, pathname: string): StaticResolution {
  const root = resolve(mobileDir);
  if (!existsSync(root)) return { ok: false, status: 503, message: 'Build do aplicativo móvel não encontrado.' };

  const pathCheck = sanitizeStaticPath(pathname);
  if (!pathCheck.ok) return pathCheck;

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, status: 503, message: 'Build do aplicativo móvel não encontrado.' };
  }

  const cleanRel = pathCheck.stripped === '' ? 'index.html' : normalize(pathCheck.stripped);
  const candidate = resolve(realRoot, cleanRel);
  if (!isInsideRoot(realRoot, candidate)) return { ok: false, status: 403, message: 'Acesso negado.' };

  const targetRes = resolveCandidateFile(realRoot, candidate);
  if (!targetRes.ok) return targetRes;
  if (!existsSync(targetRes.filePath)) return { ok: false, status: 404, message: 'Arquivo não encontrado.' };

  try {
    const finalReal = realpathSync(targetRes.filePath);
    if (!isInsideRoot(realRoot, finalReal) || !statSync(finalReal).isFile()) {
      return { ok: false, status: 403, message: 'Acesso negado.' };
    }
    return { ok: true, filePath: finalReal };
  } catch {
    return { ok: false, status: 404, message: 'Arquivo não encontrado.' };
  }
}

/** Serve os arquivos estáticos do build móvel com fallback para index.html e isolamento de diretório. */
export function serveStatic(mobileDir: string, pathname: string, res: ServerResponse): void {
  const resolved = resolveStaticFile(mobileDir, pathname);
  if (!resolved.ok) {
    return sendText(res, resolved.status, resolved.message);
  }
  const finalReal = resolved.filePath;
  const ext = extname(finalReal).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
  const noCache = ext === '.html' || ext === '.webmanifest' || finalReal.endsWith(`${sep}sw.js`);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(readFileSync(finalReal));
}

export type HttpHandlerDeps = {
  store: RemoteDeviceStore;
  log: Logger;
  mobileDir: string;
  isOriginAllowed: OriginCheck;
  parseRequestUrl: RequestUrlParser;
};

async function handlePairRequest(req: IncomingMessage, res: ServerResponse, deps: HttpHandlerDeps): Promise<void> {
  if (!deps.isOriginAllowed(req.headers.origin)) {
    return sendJson(res, 403, { error: { code: 'USAGE', message: 'Origem não permitida para pareamento.' } });
  }
  const contentType = req.headers['content-type']?.toLowerCase().split(';')[0]?.trim();
  if (contentType !== 'application/json') {
    return sendJson(res, 415, { error: { code: 'USAGE', message: 'Content-Type deve ser application/json.' } });
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Requisição inválida.';
    const status = message.includes('64 KB') ? 413 : 400;
    return sendJson(res, status, { error: { code: 'USAGE', message } });
  }
  const parsed = remotePairRequestSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? 'Dados de pareamento inválidos.';
    return sendJson(res, 400, { error: { code: 'USAGE', message: msg } });
  }
  const outcome = deps.store.redeemPairing(parsed.data.pairToken, parsed.data.deviceName);
  if (!outcome.ok) {
    if (outcome.reason === 'rate_limit') {
      deps.log.warn('limite de tentativas de pareamento atingido');
      return sendJson(res, 429, { error: { code: 'CONFLICT', message: 'Muitas tentativas de pareamento. Aguarde um minuto.' } });
    }
    deps.log.warn('tentativa de pareamento com link inválido ou expirado');
    return sendJson(res, 401, { error: { code: 'INVALID_TOKEN', message: 'Link de pareamento inválido ou expirado.' } });
  }
  deps.log.info({ deviceId: outcome.device.id, deviceName: outcome.device.name }, 'dispositivo remoto pareado');
  sendJson(res, 200, { deviceToken: outcome.deviceToken, device: outcome.device });
}

/** Cria o roteador HTTP para saúde, autenticação, pareamento e arquivos estáticos do aplicativo móvel. */
export function createHttpHandler(deps: HttpHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = deps.parseRequestUrl(req);
    if (!url) {
      return sendJson(res, 400, { error: { code: 'USAGE', message: 'URL inválida.' } });
    }
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && url.pathname === '/api/me') {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const device = deps.store.authenticate(token);
      if (!device) {
        return sendJson(res, 401, { error: { code: 'INVALID_TOKEN', message: 'Token ausente ou inválido.' } });
      }
      return sendJson(res, 200, { device });
    }

    if (method === 'POST' && url.pathname === '/api/pair') {
      return handlePairRequest(req, res, deps);
    }

    if (method === 'GET' && !url.pathname.startsWith('/api/')) {
      return serveStatic(deps.mobileDir, url.pathname, res);
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } });
  };
}
