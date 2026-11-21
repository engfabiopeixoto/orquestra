import type { IncomingMessage } from 'node:http';
import type { OriginContext, RequestUrlContext } from './types.js';

/**
 * Permite somente loopback (`127.0.0.0/8`, `::1`) ou IP CGNAT do Tailscale (`100.64.0.0/10`).
 * Recusa `0.0.0.0`, `::`, LAN comum e hostnames para nunca abrir porta pública.
 */
export function isAllowedBindHost(host: string): boolean {
  const clean = host.trim();
  if (clean === '::1' || clean === '[::1]') return true;
  const parts = clean.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Formata o host para uso em URLs HTTP/WS (entre colchetes no IPv6). */
export function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/** Verifica se o cabeçalho Origin pertence ao próprio gateway ou às origens liberadas. */
export function isOriginAllowed(ctx: OriginContext, origin: string | undefined): boolean {
  if (!origin) return true;
  const port = ctx.activePort();
  const hostUrl = formatHostForUrl(ctx.host);
  const ts = ctx.tailscaleStatus();
  const allowed = new Set<string>([
    `http://${hostUrl}:${port}`,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...(ts.url ? [ts.url] : []),
    ...(ts.state === 'fallback' && ts.tailscaleIp ? [`http://${ts.tailscaleIp}:${port}`] : []),
    ...ctx.extraAllowedOrigins,
  ]);
  return allowed.has(origin);
}

/** Faz parsing seguro da URL relativa recebida no servidor HTTP/upgrade. */
export function parseRequestUrl(ctx: RequestUrlContext, req: IncomingMessage): URL | null {
  const raw = req.url ?? '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  try {
    return new URL(raw, `http://${formatHostForUrl(ctx.host)}:${ctx.activePort()}`);
  } catch {
    return null;
  }
}
