import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveExecutable } from '@orquestra/core';
import { OrqError, type JsonValue } from '@orquestra/shared';

const JS_WORKER = String.raw`
const vm = require('node:vm');
const readline = require('node:readline');
const version = 'javascript:' + process.versions.node;
console.log(JSON.stringify({ready:true,version}));
readline.createInterface({input:process.stdin}).on('line', (line) => {
  let logs = '';
  try {
    const job = JSON.parse(line);
    let value = null;
    if (!job.fingerprint) {
      const context = { IN:job.inputs, OUT:undefined, console:{log:(...args)=>{logs=(logs+args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ')+'\n').slice(0,8192)}} };
      value = new vm.Script('(function(){\n'+job.code+'\n;return typeof run === "function" ? run(IN) : OUT;})()').runInNewContext(context,{timeout:job.timeoutMs});
      if (value === undefined || (value && typeof value.then === 'function')) throw new Error('Retorne um objeto JSON síncrono em run(IN) ou atribua OUT.');
    }
    const output = JSON.stringify({ok:true,value,logs,version}, (_key, item) => { if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('O resultado contém número não finito.'); return item; });
    if (Buffer.byteLength(output)>4*1024*1024) throw new Error('Saída excede 4 MiB. Use referência de arquivo ou simplifique os dados.');
    process.stdout.write(output+'\n');
  } catch(error) { process.stdout.write(JSON.stringify({ok:false,error:String(error.message||error),logs,version})+'\n'); }
});`;

const PYTHON_WORKER = String.raw`
import sys, os, json, io, contextlib, gc
version = 'python:' + sys.version.split()[0]
print(json.dumps({'ready': True, 'version': version}), flush=True)
class Log(io.TextIOBase):
    def __init__(self): self.text = ''
    def write(self, text):
        self.text = (self.text + str(text))[:8192]
        return len(str(text))
    def flush(self): pass
for line in sys.stdin:
    log = Log()
    old_cwd, old_path = os.getcwd(), list(sys.path)
    workspace = None
    try:
        job = json.loads(line)
        value = None
        if not job.get('fingerprint'):
            workspace = os.path.realpath(job['cwd'])
            os.chdir(workspace)
            sys.path.insert(0, workspace)
            scope = {'IN': job['inputs'], 'OUT': None, '__name__': '__orquestra_algorithm__'}
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                exec(compile(job['code'], '<orquestra-algorithm>', 'exec'), scope)
                value = scope['run'](scope['IN']) if callable(scope.get('run')) else scope.get('OUT')
            if value is None: raise ValueError('Retorne um objeto JSON em run(IN) ou atribua OUT.')
        output = json.dumps({'ok': True, 'value': value, 'logs': log.text, 'version': version}, ensure_ascii=False, allow_nan=False)
        if len(output.encode('utf-8')) > 4*1024*1024: raise ValueError('Saída excede 4 MiB. Use referência de arquivo ou simplifique os dados.')
    except BaseException as error:
        output = json.dumps({'ok': False, 'error': str(error)[:8192], 'logs': log.text, 'version': version}, ensure_ascii=False)
    finally:
        if workspace:
            for name, module in list(sys.modules.items()):
                file = getattr(module, '__file__', None)
                if file:
                    try:
                        if os.path.commonpath([workspace, os.path.realpath(file)]) == workspace: sys.modules.pop(name, None)
                    except (ValueError, OSError): pass
        os.chdir(old_cwd)
        sys.path[:] = old_path
        scope = None
        value = None
        job = None
        module = None
        file = None
        line = ''
        gc.collect()
    print(output, flush=True)
    output = ''
`;

export type FlowJob = { language: 'python' | 'javascript'; executable?: string; cwd: string; code: string; inputs: Record<string, JsonValue>; timeoutMs: number; fingerprint?: boolean };
export type FlowJobResult = { value: JsonValue; logs: string; version: string };
type Queued = { job: FlowJob; signal?: AbortSignal; resolve: (value: FlowJobResult) => void; reject: (error: Error) => void; worker?: Worker; abort?: () => void; settled: boolean };
type Worker = { child: ChildProcessWithoutNullStreams; key: string; version: string; busy: boolean; dead: boolean; ready: Promise<void>; active?: Queued; buffer: string; timer?: ReturnType<typeof setTimeout>; idleTimer?: ReturnType<typeof setTimeout>; killing?: Promise<void> };

export class FlowWorkerPool {
  private readonly workers = new Set<Worker>();
  private readonly queue: Queued[] = [];
  private pumping = false;
  private closed = false;
  private readonly executables = new Map<string, string>();
  constructor(private readonly opts: { onPids?: (pids: number[]) => void; limit?: number } = {}) {}
  private pids(): void { this.opts.onPids?.([...this.workers].filter((worker) => !worker.dead).map((worker) => worker.child.pid!).filter(Boolean)); }

  private executable(job: FlowJob): { file: string; prefix: string[]; key: string } {
    if (job.language === 'javascript') return { file: process.execPath, prefix: [], key: `js:${process.execPath}:${process.versions.node}` };
    const requested = job.executable || 'python';
    const lookupKey = `${job.cwd}:${requested}`;
    const direct = isAbsolute(requested) ? requested : /[\\/]/.test(requested) ? resolve(job.cwd, requested) : null;
    let file = this.executables.get(lookupKey);
    if (file && !existsSync(file)) { this.executables.delete(lookupKey); file = undefined; }
    file ??= direct && existsSync(direct) ? direct : undefined;
    if (!file) {
      try { const resolved = resolveExecutable(requested); if (!resolved.argsPrefix.length) file = resolved.file; } catch { /* optional Python */ }
    }
    if (!file && (requested === 'python' || requested === 'python3')) {
      const base = join(process.env.MISE_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'mise'), 'installs', 'python');
      try { file = readdirSync(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((version) => join(base, version, 'python.exe')).find(existsSync); } catch { /* optional mise */ }
    }
    if (!file) throw new OrqError('APP_UNAVAILABLE', 'Python 3 não encontrado. Informe o executável no nó ou instale Python 3; JavaScript usa o Node já disponível no Orquestra.');
    file = realpathSync.native(file);
    this.executables.set(lookupKey, file);
    const stamp = statSync(file);
    return { file, prefix: [], key: `py:${file}:${stamp.size}:${stamp.mtimeMs}` };
  }

  execute(job: FlowJob, signal?: AbortSignal): Promise<FlowJobResult> {
    if (this.closed) return Promise.reject(new Error('Executor encerrado.'));
    if (signal?.aborted) return Promise.reject(new Error('Execução cancelada.'));
    if (this.queue.length >= 32) return Promise.reject(new Error('Fila de algoritmos cheia. Aguarde as execuções em andamento.'));
    return new Promise((resolve, reject) => {
      const queued: Queued = { job, signal, resolve, reject, settled: false };
      queued.abort = () => {
        if (queued.settled) return;
        if (queued.worker) void this.kill(queued.worker, new Error('Execução cancelada.'));
        else { const index = this.queue.indexOf(queued); if (index >= 0) this.queue.splice(index, 1); this.finish(queued, new Error('Execução cancelada.')); }
      };
      signal?.addEventListener('abort', queued.abort, { once: true });
      this.queue.push(queued); void this.pump();
    });
  }
  async fingerprint(job: Pick<FlowJob, 'language' | 'executable' | 'cwd'>, signal?: AbortSignal): Promise<string> {
    const executable = this.executable({ ...job, code: '', inputs: {}, timeoutMs: 10000 });
    const result = await this.execute({ ...job, code: '', inputs: {}, timeoutMs: 10000, fingerprint: true }, signal);
    return `${executable.key}:${result.version}:orq-flow-v1`;
  }
  private finish(queued: Queued, error?: Error, result?: FlowJobResult): void {
    if (queued.settled) return;
    queued.settled = true;
    if (queued.abort) queued.signal?.removeEventListener('abort', queued.abort);
    if (error) queued.reject(error); else queued.resolve(result!);
  }
  private async create(job: FlowJob): Promise<Worker> {
    const exe = this.executable(job);
    const args = job.language === 'javascript' ? ['--max-old-space-size=128', '-e', JS_WORKER] : ['-u', '-c', PYTHON_WORKER];
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^ORQ_/i.test(name)));
    const child = spawn(exe.file, [...exe.prefix, ...args], { cwd: job.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, PYTHONIOENCODING: 'utf-8' } });
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const worker: Worker = { child, key: exe.key, version: '', busy: true, dead: false, buffer: '', ready: new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }) };
    this.workers.add(worker); this.pids();
    const boot = setTimeout(() => { readyReject(new Error('O executor não iniciou a tempo.')); void this.kill(worker); }, 10000);
    child.stderr.setEncoding('utf8');
    let stderr = '';
    child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-8192); });
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      worker.buffer += data;
      if (Buffer.byteLength(worker.buffer) > 5 * 1024 * 1024) { void this.kill(worker, new Error('Saída do executor excedeu o limite.')); return; }
      let newline: number;
      while ((newline = worker.buffer.indexOf('\n')) >= 0) {
        const line = worker.buffer.slice(0, newline); worker.buffer = worker.buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.ready) { worker.version = String(message.version); clearTimeout(boot); readyResolve(); continue; }
          const active = worker.active;
          if (!active) continue;
          clearTimeout(worker.timer); worker.active = undefined; worker.busy = false;
          if (message.ok) this.finish(active, undefined, { value: message.value, logs: String(message.logs ?? '').slice(0, 8192), version: worker.version });
          else this.finish(active, new Error(String(message.error ?? 'Algoritmo falhou.')));
          worker.idleTimer = setTimeout(() => void this.kill(worker), 60000); worker.idleTimer.unref();
          void this.pump();
        } catch { void this.kill(worker, new Error('Resposta inválida do executor local.')); }
      }
    });
    child.on('error', (error) => { clearTimeout(boot); readyReject(error); void this.kill(worker, error); });
    child.on('exit', () => {
      clearTimeout(boot); clearTimeout(worker.timer); clearTimeout(worker.idleTimer);
      readyReject(new Error(stderr || 'O executor foi encerrado.'));
      if (worker.active) this.finish(worker.active, new Error(stderr || 'O executor foi encerrado.'));
      worker.dead = true; this.workers.delete(worker); this.pids(); void this.pump();
    });
    await worker.ready;
    if (job.language === 'python' && !worker.version.startsWith('python:3.')) { await this.kill(worker); throw new Error('Use Python 3. IronPython/Python 2 não é o motor deste fluxo.'); }
    worker.busy = false;
    return worker;
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.closed) {
        const next = this.queue[0]!;
        if (next.signal?.aborted) { this.queue.shift(); this.finish(next, new Error('Execução cancelada.')); continue; }
        let exe: ReturnType<FlowWorkerPool['executable']>;
        try { exe = this.executable(next.job); } catch (error) { this.queue.shift(); this.finish(next, error as Error); continue; }
        let worker = [...this.workers].find((worker) => !worker.busy && !worker.dead && worker.key === exe.key);
        if (!worker) {
          const idle = [...this.workers].find((worker) => !worker.busy && !worker.dead);
          if (this.workers.size >= (this.opts.limit ?? 2)) { if (!idle) break; await this.kill(idle); }
          try { worker = await this.create(next.job); } catch (error) { const index = this.queue.indexOf(next); if (index >= 0) this.queue.splice(index, 1); this.finish(next, error as Error); continue; }
        }
        const index = this.queue.indexOf(next); if (index >= 0) this.queue.splice(index, 1);
        if (next.signal?.aborted) { this.finish(next, new Error('Execução cancelada.')); continue; }
        if (this.closed || worker.dead) { this.finish(next, new Error('Executor encerrado.')); continue; }
        next.worker = worker; worker.active = next; worker.busy = true;
        clearTimeout(worker.idleTimer);
        worker.timer = setTimeout(() => void this.kill(worker!, new Error(`Algoritmo excedeu ${next.job.timeoutMs} ms.`)), next.job.timeoutMs + 100);
        worker.child.stdin.write(JSON.stringify(next.job) + '\n', 'utf8', (error) => { if (error) void this.kill(worker!, error); });
      }
    } finally { this.pumping = false; }
  }
  private async kill(worker: Worker, error = new Error('Executor encerrado.')): Promise<void> {
    if (worker.killing) return worker.killing;
    if (worker.dead) return;
    worker.dead = true;
    clearTimeout(worker.timer); clearTimeout(worker.idleTimer);
    if (worker.active) { this.finish(worker.active, error); worker.active = undefined; }
    worker.killing = (async () => {
      if (worker.child.exitCode === null && worker.child.pid) {
        if (process.platform === 'win32') await new Promise<void>((resolve) => execFile('taskkill', ['/PID', String(worker.child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
        else await new Promise<void>((resolve) => { worker.child.once('exit', () => resolve()); worker.child.kill('SIGKILL'); });
      }
      this.workers.delete(worker); this.pids(); void this.pump();
    })();
    await worker.killing;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const queued of this.queue.splice(0)) this.finish(queued, new Error('Executor encerrado.'));
    await Promise.all([...this.workers].map((worker) => this.kill(worker)));
  }
}
