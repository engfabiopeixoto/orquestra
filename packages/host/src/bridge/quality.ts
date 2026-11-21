import { compareReports, gitChanged, readLastReport, saveReport, type Session } from '@orquestra/core';
import {
  OrqError,
  qualityAgentPrompt,
  qualityRefactorPrompt,
  resolveQualityRefactorTarget,
  type QualityReport,
} from '@orquestra/shared';
import { measureQualityIsolated } from '../quality-worker.js';
import type { Handlers, HostBridgeOptions, OpenProject } from './context.js';

const QUALITY_CACHE_MS = 60_000;

/** Controla medição em segundo plano, cache e pedidos de qualidade/refatoração a agentes. */
export function createQualityController(deps: {
  opts: HostBridgeOptions;
  requireProject: () => OpenProject;
  requireSession: (name: string) => Session;
  getProject: () => OpenProject | null;
  isClosing: () => boolean;
  recordPids: () => void;
}) {
  const { opts } = deps;
  const pids = new Set<number>();
  const exitWaiters = new Set<() => void>();
  let pending: { dir: string; promise: Promise<QualityReport>; abort: AbortController } | null = null;
  let generation = 0;

  function waitForExit(timeoutMs = 2500): Promise<void> {
    if (pids.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        exitWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      exitWaiters.add(done);
    });
  }

  function abort(): void {
    generation++;
    pending?.abort.abort();
    pending = null;
  }

  function abortBackground(): void {
    generation++;
    pending?.abort.abort();
  }

  function beginClose(): () => Promise<void> {
    generation++;
    pending?.abort.abort();
    const pendingPromise = pending?.promise.catch(() => {});
    pending = null;
    return async () => {
      await Promise.all([pendingPromise, waitForExit(2500)]);
    };
  }

  async function measure(force: boolean): Promise<QualityReport> {
    const current = deps.requireProject();
    const dir = current.dir;
    if (pending && pending.dir === dir) return pending.promise;

    const gen = generation;
    const previous = await readLastReport(dir);
    if (!force && previous) {
      const ageMs = Date.now() - new Date(previous.measuredAt).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < QUALITY_CACHE_MS) {
        return previous;
      }
    }

    if (deps.isClosing() || gen !== generation || deps.getProject()?.dir !== dir) {
      throw new OrqError('APP_UNAVAILABLE', 'Medição de qualidade cancelada.');
    }
    if (pending && pending.dir === dir) return pending.promise;

    const abortController = new AbortController();
    let entry!: { dir: string; promise: Promise<QualityReport>; abort: AbortController };
    const promise = (async () => {
      try {
        const [rawReport, changedFiles] = await Promise.all([
          measureQualityIsolated({
            script: opts.qualityScript ?? process.argv[1]!,
            dir,
            signal: abortController.signal,
            onStart: (pid) => {
              pids.add(pid);
              deps.recordPids();
            },
            onExit: (pid) => {
              pids.delete(pid);
              deps.recordPids();
              if (pids.size === 0) {
                for (const wake of [...exitWaiters]) wake();
              }
            },
          }),
          gitChanged(dir),
        ]);

        if (deps.isClosing() || abortController.signal.aborted || gen !== generation || deps.getProject()?.dir !== dir) {
          throw new OrqError('APP_UNAVAILABLE', 'Medição de qualidade cancelada.');
        }

        const compared = compareReports(previous, rawReport, changedFiles);
        const report: QualityReport = {
          ...rawReport,
          metrics: compared.metrics,
          changed: compared.changed,
        };
        await saveReport(dir, report);
        return report;
      } finally {
        if (pending === entry) pending = null;
      }
    })();

    entry = { dir, promise, abort: abortController };
    pending = entry;
    return promise;
  }

  const handlers: Pick<Handlers, 'quality.read' | 'quality.measure' | 'quality.ask'> = {
    'quality.read': async () => ({ report: await readLastReport(deps.requireProject().dir) }),
    'quality.measure': async () => measure(true),
    'quality.ask': async (params) => {
      const current = deps.requireProject();
      const session = deps.requireSession(params.name);
      if (!session.adapter.acceptsPrompts) {
        throw new OrqError('UNSUPPORTED', `${params.name} é um shell e não recebe prompts. Use orq read para ler a tela.`);
      }
      const report = await readLastReport(current.dir);
      if (params.kind === 'refactor') {
        const target = resolveQualityRefactorTarget(report, params.target);
        if (!target) {
          throw new OrqError('NOT_FOUND', 'Alvo de refatoração não encontrado na última medição. Clique em Medir de novo e tente novamente.');
        }
        await session.sendCommand(qualityRefactorPrompt(target, report));
        opts.log.info({ terminal: params.name, kind: params.kind, target }, 'pedido de qualidade enviado ao agente');
        return {};
      }
      await session.sendCommand(qualityAgentPrompt(params.kind, report));
      opts.log.info({ terminal: params.name, kind: params.kind }, 'pedido de qualidade enviado ao agente');
      return {};
    },
  };

  return {
    pids: (): Iterable<number> => pids,
    measure,
    abort,
    abortBackground,
    beginClose,
    handlers,
  };
}
