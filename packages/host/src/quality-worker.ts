import { execFile, spawn } from 'node:child_process';
import { childEnv } from '@orquestra/core';
import { OrqError, qualityReportSchema, type QualityReport } from '@orquestra/shared';

const QUALITY_TIMEOUT_MS = 120_000;
const QUALITY_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Mede a qualidade do projeto em um processo filho isolado para não bloquear o loop do host. */
export function measureQualityIsolated(opts: {
  script: string;
  dir: string;
  signal: AbortSignal;
  onStart(pid: number): void;
  onExit(pid: number): void;
}): Promise<QualityReport> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new OrqError('APP_UNAVAILABLE', 'Medição de qualidade cancelada.'));
    const env = childEnv(process.env);
    delete env.ORQ_PIPE;
    delete env.ORQ_TOKEN;

    const child = spawn(process.execPath, [opts.script, '--quality', opts.dir], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) opts.onStart(child.pid);

    let output = '';
    let outputBytes = 0;
    let settled = false;
    let exited = false;
    const emitExit = () => {
      if (!exited && child.pid) {
        exited = true;
        opts.onExit(child.pid);
      }
    };
    const finish = (error?: Error, value?: QualityReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value!);
    };

    const kill = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
      } else {
        child.kill();
      }
    };

    const abort = () => {
      kill();
      finish(new OrqError('APP_UNAVAILABLE', 'Medição de qualidade cancelada.'));
    };
    const timer = setTimeout(() => {
      kill();
      finish(new OrqError('APP_UNAVAILABLE', 'A medição de qualidade demorou demais (limite de 120 s).'));
    }, QUALITY_TIMEOUT_MS);

    opts.signal.addEventListener('abort', abort, { once: true });
    child.stderr.resume();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk, 'utf8');
      if (outputBytes > QUALITY_MAX_OUTPUT_BYTES) {
        kill();
        finish(new OrqError('INTERNAL', 'Saída da medição de qualidade excedeu o limite de 32 MB.'));
        return;
      }
      output += chunk;
    });

    child.on('error', () => {
      emitExit();
      finish(new OrqError('APP_UNAVAILABLE', 'Não foi possível iniciar a medição de qualidade.'));
    });

    child.on('close', () => {
      emitExit();
      if (settled) return;
      try {
        const result = JSON.parse(output) as { ok?: unknown; error?: unknown; report?: unknown };
        if (!result.ok) {
          return finish(
            new OrqError(
              'APP_UNAVAILABLE',
              typeof result.error === 'string' ? result.error : 'Medição de qualidade indisponível.',
            ),
          );
        }
        finish(undefined, qualityReportSchema.parse(result.report));
      } catch {
        finish(new OrqError('INTERNAL', 'Resposta da medição de qualidade não reconhecida.'));
      }
    });
  });
}
