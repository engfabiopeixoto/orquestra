import { homedir } from 'node:os';
import { readClaudeUsage, readCodexUsage, type Orquestra, type SubscriptionUsage } from '@orquestra/core';
import { OrqError } from '@orquestra/shared';
import { readAgyUsageIsolated } from '../usage-worker.js';
import type { HostBridgeOptions, OpenProject } from './context.js';

/** Controla consulta, cache e processos isolados de uso das assinaturas de IA. */
export function createUsageController(deps: {
  opts: HostBridgeOptions;
  getOrquestra: () => Orquestra | undefined;
  getProject: () => OpenProject | null;
  recordPids: () => void;
}) {
  const { opts } = deps;
  const cache = opts.usageState?.cache ?? new Map<string, { expiresAt: number; value: SubscriptionUsage }>();
  const pendingMap = opts.usageState?.pending ?? new Map<string, Promise<SubscriptionUsage>>();
  const failures = opts.usageState?.failures ?? new Map<string, { retryAt: number; message: string }>();
  const abortController = new AbortController();
  const pids = new Set<number>();

  async function consultUsage(
    provider: string,
    read: () => Promise<SubscriptionUsage>,
    usageProvider: 'claude' | 'codex' | 'agy',
  ): Promise<SubscriptionUsage> {
    const cached = cache.get(provider);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const failure = failures.get(provider);
    if (failure && failure.retryAt > Date.now()) throw new OrqError('APP_UNAVAILABLE', failure.message);
    const pending = pendingMap.get(provider);
    if (pending) return pending;

    const reading = (async () => {
      try {
        const value = await read();
        cache.set(provider, { expiresAt: Date.now() + (provider === 'claude' ? 300000 : 60000), value });
        failures.delete(provider);
        opts.send({ kind: 'event', event: { type: 'usage.updated', provider: usageProvider, usage: value } });
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Consulta de uso indisponível.';
        failures.set(provider, { retryAt: Date.now() + 60000, message });
        throw new OrqError('APP_UNAVAILABLE', message);
      } finally {
        pendingMap.delete(provider);
      }
    })();

    pendingMap.set(provider, reading);
    return reading;
  }

  async function getProviderUsage(provider: 'claude' | 'codex' | 'agy'): Promise<SubscriptionUsage> {
    if (provider === 'codex') return consultUsage('codex', opts.usageReaders?.codex ?? readCodexUsage, 'codex');
    if (provider === 'claude') return consultUsage('claude', opts.usageReaders?.claude ?? readClaudeUsage, 'claude');
    const cwd = deps.getOrquestra()?.sessions().find((session) => session.adapter.kind === 'agy')?.cwd ?? deps.getProject()?.dir ?? homedir();
    return consultUsage(
      `agy:${cwd}`,
      opts.usageReaders?.agy ??
        (() =>
          readAgyUsageIsolated({
            script: process.argv[1]!,
            cwd,
            signal: abortController.signal,
            onStart: (pid) => {
              pids.add(pid);
              deps.recordPids();
            },
            onExit: (pid) => {
              pids.delete(pid);
              deps.recordPids();
            },
          })),
      'agy',
    );
  }

  return {
    pids: (): Iterable<number> => pids,
    getProviderUsage,
    abort: () => abortController.abort(),
    handlers: {
      'usage.codex': async () => getProviderUsage('codex'),
      'usage.claude': async () => getProviderUsage('claude'),
      'usage.agy': async () => getProviderUsage('agy'),
    },
  };
}
