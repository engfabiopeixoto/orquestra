import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  HOST_EXIT_PIPE_BUSY,
  hostToMainSchema,
  OrqError,
  parseHostResult,
  type HostEvent,
  type HostMethod,
  type HostParams,
  type HostResult,
} from '@orquestra/shared';

export type HostProcessOptions = {
  nodePath: string;
  script: string;
  env: Record<string, string | undefined>;
  startTimeoutMs?: number;
  onLog?: (line: string) => void;
};

type Pending = { method: HostMethod; resolve: (value: unknown) => void; reject: (error: OrqError) => void };

const unavailable = (message: string) => new OrqError('APP_UNAVAILABLE', message);

export class HostProcess {
  private child: ChildProcess | undefined;
  private stopping = false;
  private readonly pending = new Map<string, Pending>();
  private readonly eventListeners = new Set<(event: HostEvent) => void>();
  private readonly exitListeners = new Set<(code: number | null) => void>();
  private confirmHandler: (message: string) => Promise<boolean> = async () => false;
  private browserHandler: (workspaceId: string, method: import('@orquestra/shared').BrowserMethod, params: unknown, signal: AbortSignal) => Promise<unknown> = async () => { throw unavailable('Navegador indisponível.'); };
  private readonly browserCalls = new Map<string, AbortController>();

  constructor(private readonly opts: HostProcessOptions) {}

  start(): Promise<void> {
    this.stopping = false;
    return new Promise((resolve, reject) => {
      // Nunca shell: true — o canal IPC não atravessa o cmd.exe.
      const child = spawn(this.opts.nodePath, [this.opts.script], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: this.opts.env,
        windowsHide: true,
      });
      this.child = child;
      let ready = false;
      const timer = setTimeout(
        () => reject(unavailable('O núcleo do Orquestra não ficou pronto a tempo. Veja o log em %APPDATA%\\Orquestra\\logs.')),
        this.opts.startTimeoutMs ?? 15_000,
      );
      child.stdout?.resume();
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) if (line) this.opts.onLog?.(line);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(unavailable(`Não foi possível iniciar o núcleo (${error.message}). Confira o caminho do Node.`));
      });
      child.on('message', (raw) => {
        const parsed = hostToMainSchema.safeParse(raw);
        if (!parsed.success) return this.opts.onLog?.(`mensagem inválida do núcleo: ${JSON.stringify(raw).slice(0, 200)}`);
        const message = parsed.data;
        if (message.kind === 'ready') {
          clearTimeout(timer);
          ready = true;
          resolve();
        } else if (message.kind === 'response' || message.kind === 'response-error') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          if (message.kind === 'response-error') return pending.reject(new OrqError(message.error.code, message.error.message));
          try {
            pending.resolve(parseHostResult(pending.method, message.result));
          } catch {
            pending.reject(new OrqError('INTERNAL', 'Resposta inválida do núcleo. Reinicie o app.'));
          }
        } else if (message.kind === 'portal-cancel') {
          this.browserCalls.get(message.id)?.abort(); this.browserCalls.delete(message.id);
        } else if (message.kind === 'portal-call') {
          const controller = new AbortController(); this.browserCalls.set(message.id, controller);
          void this.browserHandler(message.workspaceId ?? '', message.method, message.params, controller.signal).then((result) => {
            if (child.connected && !controller.signal.aborted) child.send({ kind: 'portal-reply', id: message.id, ok: true, result });
          }).catch((error) => {
            if (child.connected && !controller.signal.aborted) child.send({ kind: 'portal-reply', id: message.id, ok: false, error: { code: error instanceof OrqError ? error.code : 'USAGE', message: (error as Error).message } });
          }).finally(() => this.browserCalls.delete(message.id));
        } else if (message.kind === 'event') {
          for (const listener of this.eventListeners) listener(message.event);
        } else {
          void this.confirmHandler(message.message).then((approved) => {
            if (child.connected) child.send({ kind: 'confirm-reply', id: message.id, approved });
          });
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        // Saiu antes do ready (pipe ocupado, erro de import): falha já, em vez de esperar o prazo.
        if (!ready) {
          const message =
            code === HOST_EXIT_PIPE_BUSY
              ? 'Outro Orquestra (ou o harness de desenvolvimento) já está usando o pipe do Orquestra. Feche o outro e abra de novo.'
              : `O núcleo do Orquestra parou ao iniciar (código ${code}). Veja o log em %APPDATA%\\Orquestra\\logs.`;
          reject(unavailable(message));
        }
        for (const pending of this.pending.values()) pending.reject(unavailable('O núcleo do Orquestra parou. Reinicie o app.'));
        this.pending.clear();
        for (const controller of this.browserCalls.values()) controller.abort(); this.browserCalls.clear();
        this.child = undefined;
        if (!this.stopping) for (const listener of this.exitListeners) listener(code);
      });
    });
  }

  request<M extends HostMethod>(method: M, params: HostParams<M>, workspaceId?: string): Promise<HostResult<M>> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(unavailable('O núcleo do Orquestra não está rodando. Reinicie o app.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve: (value) => resolve(value as HostResult<M>), reject });
      child.send({ kind: 'command', id, method, params, workspaceId });
    });
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onUnexpectedExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  setConfirmHandler(handler: (message: string) => Promise<boolean>): void {
    this.confirmHandler = handler;
  }
  setBrowserHandler(handler: typeof this.browserHandler): void { this.browserHandler = handler; }

  async stop(timeoutMs = 5000): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    if (child.connected) child.send({ kind: 'shutdown' });
    const clean = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
    if (clean) return;
    // Não saiu a tempo: derruba a árvore inteira (o núcleo e os agentes dele).
    await new Promise<void>((resolve) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    await exited;
  }
}
