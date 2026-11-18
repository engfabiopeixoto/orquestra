import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import {
  REMOTE_TAILSCALE_HTTPS_PORT,
  type RemoteTailscaleStatus,
} from '@orquestra/shared';
import type { Logger } from '@orquestra/core';

export const TAILSCALE_WIN_EXE = 'C:/Program Files/Tailscale/tailscale.exe';
export const DEFAULT_TAILSCALE_TIMEOUT_MS = 10_000;

export type TailscaleExecResult = { stdout: string; stderr: string };
export type TailscaleRunner = (file: string, args: string[]) => Promise<TailscaleExecResult>;

export type TailscaleController = {
  startServe(localPort: number): Promise<RemoteTailscaleStatus>;
  stopServe(): Promise<void>;
};

export type TailscaleServeManagerOptions = {
  runner?: TailscaleRunner;
  fileExists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  httpsPort?: number;
  timeoutMs?: number;
  log?: Logger;
};

export function createDefaultTailscaleRunner(timeoutMs = DEFAULT_TAILSCALE_TIMEOUT_MS): TailscaleRunner {
  return (file: string, args: string[]) =>
    new Promise<TailscaleExecResult>((resolve, reject) => {
      execFile(
        file,
        args,
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            const detail = [stderr, stdout, error.message]
              .map((s) => (typeof s === 'string' ? s.trim() : ''))
              .find(Boolean);
            reject(new Error(detail || 'Falha ao executar o comando tailscale.'));
            return;
          }
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        },
      );
    });
}

function isTailscaleCgnatIp(ip: string): boolean {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : -1));
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 100 && b >= 64 && b <= 127;
}

export async function resolveTailscaleExecutable(opts: {
  runner?: TailscaleRunner;
  fileExists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string | null> {
  const checkExists = opts.fileExists ?? existsSync;
  const env = opts.env ?? process.env;

  if (checkExists(TAILSCALE_WIN_EXE)) {
    return TAILSCALE_WIN_EXE;
  }

  const pathEnv = env.PATH ?? env.Path ?? '';
  const candidates = process.platform === 'win32' ? ['tailscale.exe'] : ['tailscale.exe', 'tailscale'];
  for (const rawDir of pathEnv.split(delimiter)) {
    const dir = rawDir.trim();
    if (!dir || !isAbsolute(dir)) continue;
    for (const name of candidates) {
      const candidate = join(dir, name);
      if (checkExists(candidate)) return candidate;
    }
  }

  if (opts.runner) {
    try {
      const systemRoot = env.SystemRoot || env.SYSTEMROOT || process.env.SystemRoot || 'C:\\Windows';
      const whereExe = join(systemRoot, 'System32', 'where.exe');
      const { stdout } = await opts.runner(whereExe, ['$PATH:tailscale.exe']);
      const found = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && isAbsolute(line) && line.toLowerCase().endsWith('.exe') && checkExists(line));
      if (found) return found;
    } catch {
      // falha no fallback do where.exe; segue para retorno null
    }
  }

  return null;
}

type RawTailscaleStatus = {
  BackendState?: unknown;
  CertDomains?: unknown;
  TailscaleIPs?: unknown;
  Self?: {
    DNSName?: unknown;
    TailscaleIPs?: unknown;
  } | null;
};

export type TailscaleProbeResult = {
  binary: string | null;
  backendState: string | null;
  dnsName: string | null;
  certDomains: string[];
  tailscaleIp: string | null;
  error: string | null;
};

export async function probeTailscaleStatus(opts: {
  runner: TailscaleRunner;
  fileExists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<TailscaleProbeResult> {
  const binary = await resolveTailscaleExecutable(opts);
  if (!binary) {
    return {
      binary: null,
      backendState: null,
      dnsName: null,
      certDomains: [],
      tailscaleIp: null,
      error: 'Tailscale não encontrado neste computador. Instale o Tailscale para acessar pelo celular.',
    };
  }

  let raw: RawTailscaleStatus;
  try {
    const { stdout } = await opts.runner(binary, ['status', '--json']);
    raw = JSON.parse(stdout) as RawTailscaleStatus;
  } catch {
    return {
      binary,
      backendState: null,
      dnsName: null,
      certDomains: [],
      tailscaleIp: null,
      error: 'Não foi possível consultar o estado do Tailscale. Verifique se o aplicativo do Tailscale está aberto.',
    };
  }

  const backendState = typeof raw.BackendState === 'string' ? raw.BackendState : null;
  const rawDns =
    typeof raw.Self?.DNSName === 'string'
      ? raw.Self.DNSName.replace(/\.+$/, '').trim().toLowerCase()
      : '';
  const dnsName = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(rawDns) ? rawDns : null;
  const certDomains = Array.isArray(raw.CertDomains)
    ? raw.CertDomains.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    : [];
  const ips = [
    ...(Array.isArray(raw.TailscaleIPs) ? raw.TailscaleIPs : []),
    ...(Array.isArray(raw.Self?.TailscaleIPs) ? raw.Self.TailscaleIPs : []),
  ];
  const tailscaleIp =
    ips.find((ip): ip is string => typeof ip === 'string' && isTailscaleCgnatIp(ip)) ?? null;

  if (backendState !== 'Running') {
    const error =
      backendState === 'NeedsLogin' || backendState === 'NoState'
        ? 'Tailscale desconectado neste computador. Faça login no Tailscale e tente novamente.'
        : backendState === 'Stopped'
          ? 'O Tailscale está parado neste computador. Conecte o Tailscale e tente novamente.'
          : `O Tailscale não está conectado (estado: ${backendState ?? 'desconhecido'}). Conecte o Tailscale neste computador.`;
    return { binary, backendState, dnsName, certDomains, tailscaleIp, error };
  }

  if (!dnsName) {
    return {
      binary,
      backendState,
      dnsName: null,
      certDomains,
      tailscaleIp,
      error: 'MagicDNS não está habilitado para esta máquina no Tailscale. Habilite o MagicDNS ou use o plano B em HTTP.',
    };
  }

  if (certDomains.length === 0) {
    return {
      binary,
      backendState,
      dnsName,
      certDomains,
      tailscaleIp,
      error: 'Certificados HTTPS não estão habilitados na sua tailnet (sem CertDomains). Ative HTTPS no painel do Tailscale ou use o plano B em HTTP.',
    };
  }

  return { binary, backendState, dnsName, certDomains, tailscaleIp, error: null };
}

export class TailscaleServeManager implements TailscaleController {
  private readonly runner: TailscaleRunner;
  private readonly fileExists?: (path: string) => boolean;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly httpsPort: number;
  private readonly log?: Logger;
  private activeBinary: string | null = null;

  constructor(opts: TailscaleServeManagerOptions = {}) {
    this.runner = opts.runner ?? createDefaultTailscaleRunner(opts.timeoutMs);
    this.fileExists = opts.fileExists;
    this.env = opts.env;
    this.httpsPort = opts.httpsPort ?? REMOTE_TAILSCALE_HTTPS_PORT;
    this.log = opts.log;
  }

  async startServe(localPort: number): Promise<RemoteTailscaleStatus> {
    const probe = await probeTailscaleStatus({
      runner: this.runner,
      fileExists: this.fileExists,
      env: this.env,
    });

    if (probe.error || !probe.binary || !probe.dnsName) {
      this.activeBinary = null;
      return {
        state: 'error',
        dnsName: probe.dnsName,
        url: null,
        error: probe.error ?? 'Tailscale indisponível.',
        tailscaleIp: probe.tailscaleIp,
      };
    }

    try {
      await this.runner(probe.binary, [
        'serve',
        '--bg',
        `--https=${this.httpsPort}`,
        `http://127.0.0.1:${localPort}`,
      ]);
      this.activeBinary = probe.binary;
      const url = `https://${probe.dnsName}:${this.httpsPort}`;
      this.log?.info({ url, localPort, httpsPort: this.httpsPort }, 'tailscale serve ativado');
      return {
        state: 'serving',
        dnsName: probe.dnsName,
        url,
        error: null,
        tailscaleIp: probe.tailscaleIp,
      };
    } catch (err) {
      this.activeBinary = null;
      const detail = err instanceof Error ? err.message : String(err);
      this.log?.warn({ err: detail, httpsPort: this.httpsPort }, 'falha ao ativar tailscale serve');
      return {
        state: 'error',
        dnsName: probe.dnsName,
        url: null,
        error: `Não foi possível ativar o tailscale serve na porta ${this.httpsPort}: ${detail}. Você pode usar o plano B em HTTP pelo IP do Tailscale.`,
        tailscaleIp: probe.tailscaleIp,
      };
    }
  }

  async stopServe(): Promise<void> {
    const binary =
      this.activeBinary ??
      (await resolveTailscaleExecutable({
        runner: this.runner,
        fileExists: this.fileExists,
        env: this.env,
      }));
    this.activeBinary = null;
    if (!binary) return;
    try {
      // Remove SOMENTE a regra da porta httpsPort; nunca usa `serve reset`.
      await this.runner(binary, ['serve', `--https=${this.httpsPort}`, 'off']);
      this.log?.info({ httpsPort: this.httpsPort }, 'tailscale serve desativado');
    } catch (err) {
      this.log?.warn({ err, httpsPort: this.httpsPort }, 'falha ao remover regra do tailscale serve');
    }
  }
}
