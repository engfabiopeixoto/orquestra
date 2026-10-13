import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compatiblePorts, defaultFlowNode, equalWithTolerance, flowGraphSchema, flowNodeSchema, flowPortSchema, jsonBytes, jsonValueSchema, OrqError, validateFlowValue, type FlowGraph, type FlowNode, type FlowPort, type FlowRun, type FlowNodeResult, type FlowSnapshot, type FlowTestReport, type FlowArtifact, type HostEvent, type JsonValue } from '@orquestra/shared';
import { FlowArtifacts, flowHash, projectPath, stableJson } from './flow-artifacts.js';
import { FlowWorkerPool } from './flow-workers.js';
import { validateFlowSchema } from '@orquestra/shared';

const result = (status: FlowNodeResult['status'], message = ''): FlowNodeResult => ({ status, message: message.slice(0, 8192), outputs: {}, logs: '', durationMs: 0, codeHash: '', runtime: '' });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
type Agent = { id: string; name: string; position: { x: number; y: number } };
export type FlowEngineOptions = {
  dir: string; graph?: FlowGraph; workers: FlowWorkerPool; changed: (graph: FlowGraph) => void; emit: (event: HostEvent) => void;
  agent: (terminalId: string, text: string, timeoutMs: number, signal: AbortSignal) => Promise<string>;
};

function ancestors(graph: FlowGraph, targets: string[]): Set<string> {
  const set = new Set<string>();
  function visit(id: string) { if (set.has(id)) return; if (!graph.nodes.some((node) => node.id === id)) throw new Error('Nó não encontrado no workspace.'); set.add(id); graph.connections.filter((edge) => edge.to === id).forEach((edge) => visit(edge.from)); }
  targets.forEach(visit); return set;
}
function order(graph: FlowGraph, selected: Set<string>): FlowNode[] {
  const sorted: FlowNode[] = [], visited = new Set<string>();
  function visit(id: string) { if (visited.has(id)) return; visited.add(id); graph.connections.filter((edge) => edge.to === id && selected.has(edge.from)).forEach((edge) => visit(edge.from)); const node = graph.nodes.find((node) => node.id === id); if (node) sorted.push(node); }
  selected.forEach(visit); return sorted;
}
function revision(graph: FlowGraph): string {
  return flowHash(stableJson({ nodes: graph.nodes.map(({ id, kind, inputs, outputs, config }) => ({ id, kind, inputs, outputs, config })), connections: graph.connections }));
}
function csv(text: string): JsonValue {
  const rows: string[][] = [], row: string[] = []; let field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') { if (quoted && text[index + 1] === '"') { field += '"'; index++; } else quoted = !quoted; }
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) { if (char === '\r' && text[index + 1] === '\n') index++; row.push(field); rows.push([...row]); row.length = 0; field = ''; }
    else field += char;
  }
  if (quoted) throw new Error('CSV com aspas não fechadas.');
  if (field || row.length) { row.push(field); rows.push([...row]); }
  const headers = rows.shift() ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((name, index) => [name, values[index] ?? ''])));
}

export class FlowEngine {
  private graph: FlowGraph;
  private run: FlowRun | null = null;
  private runGraph: FlowGraph | null = null;
  private tests: FlowTestReport | null = null;
  private readonly artifacts: FlowArtifacts;
  private active: { controller: AbortController; done: Promise<void> } | null = null;
  private autoTimer?: ReturnType<typeof setTimeout>;
  private autoPending = false;
  private disposed = false;
  private readonly capacityNotices = new Set<string>();
  constructor(private readonly opts: FlowEngineOptions) {
    this.graph = flowGraphSchema.parse(opts.graph ?? {}); this.artifacts = new FlowArtifacts(opts.dir);
    const latest = this.artifacts.latest(); this.run = latest?.run ?? null; this.runGraph = latest?.graph ?? null;
    if (this.run) this.run.stale = this.run.revision !== revision(this.graph);
  }
  snapshot(): FlowSnapshot { return { graph: clone(this.graph), run: this.run ? clone(this.run) : null, tests: this.tests ? clone(this.tests) : null }; }
  private publishGraph(schedule = true): FlowSnapshot {
    if (this.run) this.run.stale = this.run.revision !== revision(this.graph);
    this.opts.changed(clone(this.graph)); this.opts.emit({ type: 'flow.graph', graph: clone(this.graph), revision: revision(this.graph) });
    if (schedule && this.graph.autoRun) { clearTimeout(this.autoTimer); this.autoTimer = setTimeout(() => this.automatic(), 500); this.autoTimer.unref(); }
    return this.snapshot();
  }
  syncAgents(agents: Agent[]): void {
    let changed = false;
    const valid = new Set(agents.map((agent) => agent.id));
    const removed = this.graph.nodes.filter((node) => node.kind === 'agent' && node.config.terminalId && !valid.has(node.config.terminalId));
    if (removed.length) { const ids = new Set(removed.map((node) => node.id)); this.graph.nodes = this.graph.nodes.filter((node) => !ids.has(node.id)); this.graph.connections = this.graph.connections.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to)); changed = true; }
    for (const agent of agents) if (!this.graph.nodes.some((node) => node.kind === 'agent' && node.config.terminalId === agent.id)) {
      if (this.graph.nodes.length >= 200) {
        if (!this.capacityNotices.has(agent.id)) { this.capacityNotices.add(agent.id); this.opts.emit({ type: 'notice', level: 'warn', message: `O fluxo atingiu 200 nós. Remova uma etapa para habilitar as portas de ${agent.name}.` }); }
        continue;
      }
      this.capacityNotices.delete(agent.id);
      const node = defaultFlowNode('agent', agent.id, agent.position); node.title = agent.name; node.config.terminalId = agent.id; this.graph.nodes.push(node); changed = true;
    }
    if (changed) this.publishGraph(false);
  }
  save(raw: FlowNode, checkLayout?: () => void): FlowSnapshot {
    const node = flowNodeSchema.parse(raw);
    if (node.kind !== 'agent') node.size.height = Math.max(node.size.height, 130 + Math.max(node.inputs.length, node.outputs.length) * 26);
    const next = clone(this.graph), index = next.nodes.findIndex((current) => current.id === node.id);
    if (index >= 0) next.nodes[index] = node; else next.nodes.push(node);
    this.validate(next);
    const before = this.graph; this.graph = next;
    try { checkLayout?.(); } catch (error) { this.graph = before; throw error; }
    return this.publishGraph();
  }
  remove(id: string): FlowSnapshot {
    if (!this.graph.nodes.some((node) => node.id === id)) throw new Error('Nó não encontrado.');
    this.graph.nodes = this.graph.nodes.filter((node) => node.id !== id); this.graph.connections = this.graph.connections.filter((edge) => edge.from !== id && edge.to !== id);
    return this.publishGraph();
  }
  connect(input: { from: string; output: string; to: string; input: string }): FlowSnapshot {
    const graph = clone(this.graph); graph.connections.push({ ...input, id: randomUUID() }); this.validate(graph); this.graph = graph; return this.publishGraph();
  }
  disconnect(id: string): FlowSnapshot { this.graph.connections = this.graph.connections.filter((edge) => edge.id !== id); return this.publishGraph(); }
  move(nodes: Array<{ id: string; position: { x: number; y: number }; size?: { width: number; height: number } }>): void {
    this.moveQuiet(nodes); this.commitLayout();
  }
  moveQuiet(nodes: Array<{ id: string; position: { x: number; y: number }; size?: { width: number; height: number } }>): void {
    const next = clone(this.graph);
    for (const moved of nodes) { const node = next.nodes.find((node) => node.id === moved.id); if (!node) throw new Error('Nó não encontrado.'); node.position = moved.position; if (moved.size) node.size = moved.size; }
    this.validate(next); this.graph = next;
  }
  commitLayout(): void { this.publishGraph(false); }
  restoreGraph(graph: FlowGraph): void { this.graph = clone(graph); }
  setAuto(enabled: boolean): FlowSnapshot { this.graph.autoRun = enabled; clearTimeout(this.autoTimer); this.autoPending = false; return this.publishGraph(enabled); }
  private validate(graph: FlowGraph): void {
    const parsed = flowGraphSchema.safeParse(graph);
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join('; '));
    for (const node of graph.nodes) for (const port of [...node.inputs, ...node.outputs]) if (port.schema !== null) validateFlowSchema(port.schema, port.name);
    for (const edge of graph.connections) {
      const output = graph.nodes.find((node) => node.id === edge.from)!.outputs.find((port) => port.name === edge.output)!;
      const input = graph.nodes.find((node) => node.id === edge.to)!.inputs.find((port) => port.name === edge.input)!;
      if (!compatiblePorts(output, input)) throw new Error(`Portas incompatíveis: ${output.name} (${output.type}) → ${input.name} (${input.type}).`);
    }
  }
  private automatic(): void {
    if (this.disposed || !this.graph.autoRun) return;
    if (this.active) { this.autoPending = true; return; }
    const targets = this.graph.nodes.filter((node) => {
      const parents = ancestors(this.graph, [node.id]);
      return [...parents].every((id) => { const item = this.graph.nodes.find((node) => node.id === id)!; return item.kind !== 'agent' && (item.kind !== 'code' || item.config.deterministic); });
    }).map((node) => node.id);
    if (targets.length) { try { this.start({ targets }); } catch { /* visible status remains on the last run */ } }
  }
  start(input: { targets?: string[]; force?: boolean }): FlowSnapshot {
    if (this.disposed) throw new Error('Workspace encerrado.');
    if (this.active) throw new Error('Já existe uma execução neste workspace. Aguarde ou cancele.');
    this.validate(this.graph);
    const graph = clone(this.graph);
    const connected = new Set(graph.connections.flatMap((edge) => [edge.from, edge.to]));
    const targets = input.targets?.length ? input.targets : graph.nodes.filter((node) => node.kind !== 'agent' || connected.has(node.id)).map((node) => node.id);
    if (!targets.length) throw new Error('Adicione nós de processamento ou conecte as portas antes de executar.');
    const selected = ancestors(graph, targets), sorted = order(graph, selected);
    const run: FlowRun = { id: randomUUID(), revision: revision(graph), startedAt: new Date().toISOString(), finishedAt: null, status: 'running', stale: false, results: Object.fromEntries(sorted.map((node) => [node.id, result('queued')])), agentCalls: 0, sentBytes: 0, receivedBytes: 0 };
    this.run = run; this.runGraph = graph; this.opts.emit({ type: 'flow.run', run: clone(run) });
    const controller = new AbortController();
    const done = Promise.resolve().then(() => this.executeGraph(graph, sorted, run, controller.signal, Boolean(input.force))).finally(() => {
      this.active = null;
      if (this.autoPending && !controller.signal.aborted) { this.autoPending = false; this.autoTimer = setTimeout(() => this.automatic(), 500); this.autoTimer.unref(); }
    });
    this.active = { controller, done }; return this.snapshot();
  }
  private setResult(run: FlowRun, id: string, value: FlowNodeResult): void { run.results[id] = value; this.opts.emit({ type: 'flow.node', runId: run.id, id, result: clone(value) }); }
  private async executeGraph(graph: FlowGraph, sorted: FlowNode[], run: FlowRun, signal: AbortSignal, force: boolean): Promise<void> {
    try {
      for (const node of sorted) {
        if (signal.aborted) { this.setResult(run, node.id, result('cancelled', 'Execução cancelada.')); continue; }
        const started = Date.now(); this.setResult(run, node.id, result('running'));
        try {
          const inputs: Record<string, JsonValue> = {};
          let blocked = false;
          for (const port of node.inputs) {
            const edge = graph.connections.find((edge) => edge.to === node.id && edge.input === port.name);
            let value: unknown = port.defaultValue;
            if (edge) {
              const parent = run.results[edge.from];
              if (!parent || !['success', 'cached'].includes(parent.status)) { blocked = true; break; }
              const artifact = parent.outputs[edge.output]; if (!artifact) throw new Error(`Saída ${edge.output} ausente na etapa anterior.`);
              value = this.artifacts.read(artifact);
            }
            inputs[port.name] = validateFlowValue(port, value);
            if (port.type === 'file' && inputs[port.name]) {
              const reference = inputs[port.name] as Record<string, JsonValue>;
              if (await this.hashFile(String(reference.path), signal) !== reference.hash) throw new Error(`Arquivo da porta ${port.name} mudou. Reexecute a entrada de arquivo.`);
            }
          }
          if (blocked) { this.setResult(run, node.id, result('skipped', 'Uma dependência falhou ou foi cancelada.')); continue; }
          if (jsonBytes(inputs) > 4 * 1024 * 1024) throw new Error('Entradas combinadas excedem 4 MiB. Use referências de arquivos.');
          const prepared = await this.prepare(node, signal);
          const cacheable = node.kind !== 'agent' && (node.kind !== 'code' || node.config.deterministic);
          const key = flowHash(stableJson({ kind: node.kind, inputs, contracts: { in: node.inputs, out: node.outputs }, config: node.config, ...prepared }));
          const cached = !force && cacheable ? this.artifacts.cached(key) : null;
          if (cached) {
            for (const port of node.outputs) validateFlowValue(port, this.artifacts.read(cached[port.name]!));
            this.setResult(run, node.id, { ...result('cached'), outputs: cached, durationMs: Date.now() - started, codeHash: flowHash(prepared.code), runtime: prepared.runtime }); continue;
          }
          const computed = await this.compute(node, inputs, prepared.code, signal, run);
          if (signal.aborted) throw new Error('Execução cancelada.');
          for (const [file, hash] of Object.entries(prepared.dependencies)) if (await this.hashFile(file, signal) !== hash) throw new Error('Um arquivo de dependência mudou durante a execução. Execute novamente.');
          for (const port of node.inputs.filter((port) => port.type === 'file' && inputs[port.name])) { const reference = inputs[port.name] as Record<string, JsonValue>; if (await this.hashFile(String(reference.path), signal) !== reference.hash) throw new Error('Um arquivo de entrada mudou durante a execução. Execute novamente.'); }
          const outputs = this.publishOutputs(node, computed.outputs);
          if (cacheable) this.artifacts.remember(key, outputs);
          this.setResult(run, node.id, { ...result('success'), outputs, logs: computed.logs.slice(0, 8192), durationMs: Date.now() - started, codeHash: flowHash(prepared.code), runtime: prepared.runtime });
        } catch (error) { this.setResult(run, node.id, { ...result(signal.aborted ? 'cancelled' : 'error', (error as Error).message), durationMs: Date.now() - started }); }
      }
      run.status = signal.aborted ? 'cancelled' : Object.values(run.results).some((node) => node.status === 'error' || node.status === 'skipped') ? 'error' : 'success';
    } catch (error) { run.status = signal.aborted ? 'cancelled' : 'error'; }
    finally {
      run.finishedAt = new Date().toISOString(); run.stale = run.revision !== revision(this.graph);
      try { this.artifacts.record(graph, run); } catch (error) { this.opts.emit({ type: 'notice', level: 'warn', message: `Não foi possível salvar o histórico do fluxo: ${(error as Error).message}` }); }
      this.opts.emit({ type: 'flow.run', run: clone(run) });
    }
  }
  private async hashFile(path: string, signal: AbortSignal): Promise<string> {
    const file = projectPath(this.opts.dir, path), hash = createHash('sha256');
    const stream = createReadStream(file);
    const abort = () => stream.destroy(new Error('Execução cancelada.'));
    signal.addEventListener('abort', abort, { once: true });
    try { for await (const data of stream) { if (signal.aborted) throw new Error('Execução cancelada.'); hash.update(data); } return hash.digest('hex'); }
    finally { signal.removeEventListener('abort', abort); }
  }
  private async prepare(node: FlowNode, signal: AbortSignal): Promise<{ code: string; runtime: string; dependencies: Record<string, string> }> {
    let code = node.config.code, runtime = 'builtin:v1';
    const dependencies: Record<string, string> = {};
    if (node.kind === 'code') {
      if (node.config.scriptPath) {
        const file = projectPath(this.opts.dir, node.config.scriptPath);
        if ((await stat(file)).size > 65536) throw new Error('Script excede 64 KiB.');
        code = await readFile(file, 'utf8'); dependencies[node.config.scriptPath] = flowHash(code);
      }
      for (const dependency of node.config.dependencies) dependencies[dependency] = await this.hashFile(dependency, signal);
      runtime = await this.opts.workers.fingerprint({ language: node.config.language, executable: node.config.pythonExecutable, cwd: this.opts.dir }, signal);
    }
    if (node.kind === 'file') dependencies[node.config.filePath] = await this.hashFile(node.config.filePath, signal);
    return { code, runtime, dependencies };
  }
  private wrapValue(node: FlowNode, value: JsonValue): Record<string, JsonValue> {
    if (!node.outputs.length) return {};
    if (node.outputs.length === 1) return { [node.outputs[0]!.name]: value };
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Nós com várias saídas exigem um objeto JSON com os nomes das portas.');
    return value;
  }
  private publishOutputs(node: FlowNode, raw: unknown): Record<string, FlowArtifact> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Retorne um objeto com os nomes das portas de saída.');
    const values = raw as Record<string, unknown>, outputs: Record<string, FlowArtifact> = {};
    for (const name of Object.keys(values)) if (!node.outputs.some((port) => port.name === name)) throw new Error(`Saída não declarada: ${name}. Ajuste o contrato ou o resultado.`);
    for (const port of node.outputs) outputs[port.name] = this.artifacts.put(validateFlowValue(port, values[port.name] ?? null), port.type);
    return outputs;
  }
  private async compute(node: FlowNode, inputs: Record<string, JsonValue>, code: string, signal: AbortSignal, run?: FlowRun): Promise<{ outputs: Record<string, JsonValue>; logs: string }> {
    if (node.kind === 'input') return { outputs: this.wrapValue(node, node.config.value), logs: '' };
    if (node.kind === 'file') {
      const file = projectPath(this.opts.dir, node.config.filePath), info = await stat(file);
      let value: JsonValue;
      if (node.config.fileFormat === 'reference') value = { path: node.config.filePath, hash: await this.hashFile(node.config.filePath, signal), bytes: info.size };
      else {
        if (info.size > 1024 * 1024) throw new Error('Arquivo excede 1 MiB. Use o formato referência.');
        const text = await readFile(file, 'utf8');
        value = node.config.fileFormat === 'json' ? jsonValueSchema.parse(JSON.parse(text)) : node.config.fileFormat === 'csv' ? csv(text) : text;
      }
      return { outputs: this.wrapValue(node, value), logs: '' };
    }
    if (node.kind === 'code') {
      const computed = await this.opts.workers.execute({ language: node.config.language, executable: node.config.pythonExecutable, cwd: this.opts.dir, code, inputs, timeoutMs: node.config.timeoutMs }, signal);
      const value = jsonValueSchema.parse(computed.value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('O algoritmo deve retornar um objeto com os nomes das saídas.');
      return { outputs: value, logs: computed.logs };
    }
    if (node.kind === 'agent') {
      if (!node.config.terminalId) throw new Error('Escolha um terminal de agente.');
      if (!node.config.instruction.trim()) throw new Error('Defina as instruções desta etapa antes de chamar o agente.');
      const text = `${node.config.instruction}\n\nEntradas desta execução (IN):\n${JSON.stringify(inputs)}\n\nArquivos de referência permitidos para esta tarefa: ${JSON.stringify(node.config.allowedFiles)}\nRetorne somente um objeto JSON com estas portas de saída e respeite os limites:\n${JSON.stringify(node.outputs)}\nNão acrescente outros campos nem transcrição do terminal.`;
      if (Buffer.byteLength(text) > 65536) throw new Error('Contexto do agente excede 64 KiB. Reduza as entradas/instruções ou use referências a arquivos.');
      if (run) { run.agentCalls++; run.sentBytes += Buffer.byteLength(text); }
      const answer = await this.opts.agent(node.config.terminalId, text, node.config.timeoutMs, signal);
      if (Buffer.byteLength(answer) > 131072) throw new Error('Resposta do agente excede 128 KiB. Defina saídas menores.');
      if (run) run.receivedBytes += Buffer.byteLength(answer);
      const trimmed = answer.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1');
      return { outputs: jsonValueSchema.parse(JSON.parse(trimmed)) as Record<string, JsonValue>, logs: '' };
    }
    const value = inputs[node.inputs[0]?.name ?? 'valor'] ?? null;
    if (node.kind === 'validate') {
      if ((node.config.minimum !== null || node.config.maximum !== null) && typeof value !== 'number') throw new Error('A validação de intervalo exige uma entrada numérica.');
      if (typeof value === 'number' && node.config.minimum !== null && value < node.config.minimum) throw new Error(`Resultado abaixo do mínimo ${node.config.minimum}.`);
      if (typeof value === 'number' && node.config.maximum !== null && value > node.config.maximum) throw new Error(`Resultado acima do máximo ${node.config.maximum}.`);
    }
    if (node.kind === 'test' && !equalWithTolerance(value, node.config.expected, node.config.tolerance)) throw new Error(`Teste falhou. Esperado: ${JSON.stringify(node.config.expected).slice(0, 1024)}; recebido: ${JSON.stringify(value).slice(0, 1024)}.`);
    return { outputs: this.wrapValue(node, value), logs: node.kind === 'output' ? 'Resultado preparado. Aplicar a exportação é uma ação separada.' : '' };
  }
  async test(id: string): Promise<FlowTestReport> {
    if (this.active) throw new Error('Aguarde ou cancele a execução atual antes de testar.');
    const node = this.graph.nodes.find((node) => node.id === id);
    if (!node || node.kind !== 'code') throw new Error('Selecione um nó de algoritmo local para testar.');
    if (!node.config.tests.length) throw new Error('Adicione casos de teste ao algoritmo.');
    const frozen = clone(node), report: FlowTestReport = { nodeId: id, passed: 0, failed: 0, cases: [] };
    const controller = new AbortController(); let complete!: () => void;
    this.active = { controller, done: new Promise<void>((resolve) => { complete = resolve; }) };
    try {
      const prepared = await this.prepare(frozen, controller.signal);
      for (const test of frozen.config.tests) {
        if (controller.signal.aborted) throw new Error('Testes cancelados.');
        const started = Date.now();
        try {
          const inputs = Object.fromEntries(frozen.inputs.map((port) => [port.name, validateFlowValue(port, test.inputs[port.name] ?? port.defaultValue)]));
          const computed = await this.compute(frozen, inputs, prepared.code, controller.signal);
          this.publishOutputs(frozen, computed.outputs);
          const passed = equalWithTolerance(computed.outputs, test.expected, frozen.config.tolerance);
          report.cases.push({ title: test.title, passed, message: passed ? 'Resultado esperado.' : `Esperado ${JSON.stringify(test.expected).slice(0, 1024)}; recebido ${JSON.stringify(computed.outputs).slice(0, 1024)}.`, durationMs: Date.now() - started });
          if (passed) report.passed++; else report.failed++;
        } catch (error) { report.failed++; report.cases.push({ title: test.title, passed: false, message: (error as Error).message.slice(0, 8192), durationMs: Date.now() - started }); }
      }
      this.tests = report; return report;
    } finally {
      this.active = null; complete();
      if (this.autoPending && !controller.signal.aborted) { this.autoPending = false; this.autoTimer = setTimeout(() => this.automatic(), 500); this.autoTimer.unref(); }
    }
  }
  async cancel(): Promise<FlowSnapshot> { clearTimeout(this.autoTimer); this.autoPending = false; const active = this.active; active?.controller.abort(); await active?.done; return this.snapshot(); }
  async close(): Promise<void> { this.disposed = true; await this.cancel(); }
  inspect(nodeId: string, port: string, runId?: string, direction: 'input' | 'output' = 'output') {
    const record = runId ? this.artifacts.get(runId) : null;
    const run = record?.run ?? (runId ? null : this.run);
    const graph = record?.graph ?? this.runGraph;
    const edge = direction === 'input' ? graph?.connections.find((edge) => edge.to === nodeId && edge.input === port) : null;
    const artifact = edge ? run?.results[edge.from]?.outputs[edge.output] : direction === 'output' ? run?.results[nodeId]?.outputs[port] : null;
    if (run && direction === 'input' && !edge) { const input = graph?.nodes.find((node) => node.id === nodeId)?.inputs.find((input) => input.name === port); if (input) return { value: input.defaultValue, bytes: jsonBytes(input.defaultValue), revision: run.revision, stale: run.revision !== revision(this.graph) }; }
    if (!run || !artifact) throw new Error('Esta porta ainda não tem resultado. Execute o fluxo.');
    return { value: this.artifacts.read(artifact), bytes: artifact.bytes, revision: run.revision, stale: run.revision !== revision(this.graph) };
  }
  history(): { runs: FlowRun[] } { return { runs: this.artifacts.history() }; }
  compare(before: string, after: string) {
    const a = this.artifacts.get(before), b = this.artifacts.get(after);
    if (!a || !b) throw new Error('Execução não encontrada no histórico.');
    const ids = new Set([...a.graph.nodes, ...b.graph.nodes].map((node) => node.id));
    return { changes: [...ids].map((id) => {
      const left = a.graph.nodes.find((node) => node.id === id), right = b.graph.nodes.find((node) => node.id === id);
      const outputs = new Set([...Object.keys(a.run.results[id]?.outputs ?? {}), ...Object.keys(b.run.results[id]?.outputs ?? {})]);
      return { id, title: right?.title ?? left?.title ?? id, codeChanged: stableJson(left?.config) !== stableJson(right?.config) || a.run.results[id]?.codeHash !== b.run.results[id]?.codeHash, outputsChanged: [...outputs].filter((port) => a.run.results[id]?.outputs[port]?.hash !== b.run.results[id]?.outputs[port]?.hash) };
    }).filter((change) => change.codeChanged || change.outputsChanged.length) };
  }
  private artifact(nodeId: string, port: string, runId?: string): FlowArtifact {
    const run = runId ? this.artifacts.get(runId)?.run : this.run;
    if (!run || !['success', 'cached'].includes(run.results[nodeId]?.status ?? '')) throw new Error('Execute e valide este resultado antes de exportar.');
    const artifact = run.results[nodeId]?.outputs[port]; if (!artifact) throw new Error('Porta de saída não encontrada.'); return artifact;
  }
  exportPreview(input: { nodeId: string; port: string; runId?: string; path: string }) { return this.artifacts.exportPreview(this.artifact(input.nodeId, input.port, input.runId), input.path); }
  exportApply(input: { nodeId: string; port: string; runId?: string; path: string; previousHash: string | null; nextHash: string }) { return this.artifacts.exportApply(this.artifact(input.nodeId, input.port, input.runId), input); }
  example(position: { x: number; y: number }): FlowSnapshot {
    const count = defaultFlowNode('input', randomUUID(), position); count.title = 'Quantidade de pontos'; count.outputs[0]!.name = 'quantidade'; count.outputs[0]!.label = 'quantidade'; count.config.value = 12;
    const algorithm = defaultFlowNode('code', randomUUID(), { x: position.x + 340, y: position.y }); algorithm.title = 'Hélice 3D'; algorithm.inputs = [flowPortSchema.parse({ name: 'quantidade', type: 'number', schema: { type: 'integer', minimum: 2, maximum: 1000 } })]; algorithm.outputs = [flowPortSchema.parse({ name: 'geometria', type: 'geometry', maxBytes: 4 * 1024 * 1024, unit: 'm' })];
    algorithm.config.language = 'javascript'; algorithm.config.code = 'function run(IN) {\n  const points = Array.from({length: IN.quantidade}, (_, i) => { const t = i / (IN.quantidade - 1) * Math.PI * 4; return [Math.cos(t) * 3, Math.sin(t) * 3, i * 0.3]; });\n  return {geometria: {units: "m", origin: [0,0,0], items: [{kind: "line", id: "helice", color: "#7aa7ff", points}]}};\n}';
    algorithm.config.tests = [{ title: 'Dois pontos válidos', inputs: { quantidade: 2 }, expected: { geometria: { units: 'm', origin: [0, 0, 0], items: [{ kind: 'line', id: 'helice', color: '#7aa7ff', points: [[3, 0, 0], [3, 0, 0.3]] }] } } }];
    const view = defaultFlowNode('view', randomUUID(), { x: position.x + 680, y: position.y }); view.title = 'Prévia 3D'; view.config.view = '3d'; view.inputs[0]!.type = 'geometry'; view.inputs[0]!.maxBytes = 4 * 1024 * 1024; view.outputs[0]!.type = 'geometry'; view.outputs[0]!.maxBytes = 4 * 1024 * 1024;
    const next = clone(this.graph); next.nodes.push(count, algorithm, view); next.connections.push({ id: randomUUID(), from: count.id, output: 'quantidade', to: algorithm.id, input: 'quantidade' }, { id: randomUUID(), from: algorithm.id, output: 'geometria', to: view.id, input: 'valor' }); this.validate(next); this.graph = next; return this.publishGraph(false);
  }
}
