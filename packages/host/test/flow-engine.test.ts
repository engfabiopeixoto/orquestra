import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFlowNode, flowPortSchema, type FlowGraph } from '@orquestra/shared';
import { FlowEngine } from '../src/flow-engine.js';
import { FlowWorkerPool } from '../src/flow-workers.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(agent: (terminalId: string, text: string, timeoutMs: number, signal: AbortSignal) => Promise<string> = async () => { throw new Error('Unexpected agent call'); }) {
  const dir = await mkdtemp(join(tmpdir(), 'orq-flow-'));
  const workers = new FlowWorkerPool();
  let saved: FlowGraph | undefined;
  const engine = new FlowEngine({ dir, workers, changed: (graph) => { saved = graph; }, emit: () => {}, agent });
  cleanup.push(async () => { await engine.close(); await workers.close(); await rm(dir, { recursive: true, force: true }); });
  return { engine, workers, dir, saved: () => saved };
}
async function finish(engine: FlowEngine) {
  for (let i = 0; i < 200; i++) { const snapshot = engine.snapshot(); if (snapshot.run?.status !== 'running') return snapshot; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error('Flow did not finish');
}
describe('fluxo local', () => {
  it('reconstrói artefatos alterados ao invalidar cache', async () => {
    const { engine, dir } = await setup(); const node = defaultFlowNode('input', randomUUID()); engine.save(node); engine.start({}); const first = await finish(engine);
    const hash = first.run!.results[node.id]!.outputs.valor!.hash;
    await writeFile(join(dir, '.orquestra', 'flow', 'objects', hash + '.json'), '0');
    expect(() => engine.inspect(node.id, 'valor')).toThrow(/alterado/);
    engine.start({}); const rebuilt = await finish(engine); expect(rebuilt.run?.status).toBe('success'); expect(engine.inspect(node.id, 'valor').value).toBe(1);
  });
  it('agentes recebem apenas entradas declaradas e nunca são chamados por auto local', async () => {
    const agent = vi.fn(async (_terminalId: string, _text: string, _timeoutMs: number, _signal: AbortSignal) => '{"saida":42}'); const { engine } = await setup(agent);
    const source = defaultFlowNode('input', randomUUID()), target = defaultFlowNode('agent', randomUUID());
    target.config.terminalId = target.id; target.config.instruction = 'Calcule'; target.outputs = [flowPortSchema.parse({ name: 'saida', type: 'number' })];
    engine.save(source); engine.save(target); engine.connect({ from: source.id, output: 'valor', to: target.id, input: 'entrada' });
    engine.setAuto(true); await new Promise((resolve) => setTimeout(resolve, 650)); await finish(engine); expect(agent).not.toHaveBeenCalled();
    engine.setAuto(false); engine.start({ targets: [target.id] }); const run = (await finish(engine)).run!;
    expect(run.status).toBe('success'); expect(run.agentCalls).toBe(1); expect(run.sentBytes).toBeGreaterThan(0);
    expect(agent.mock.calls[0]![1]).toContain('"entrada":1'); expect(engine.inspect(target.id, 'saida').value).toBe(42);
  });
  it('arquivos de script e referências invalidam cache pelo conteúdo e não por posição', async () => {
    const { engine, dir } = await setup(); const node = defaultFlowNode('code', randomUUID()); node.config.language = 'javascript'; node.config.scriptPath = 'algorithm.js'; node.inputs[0]!.defaultValue = 2;
    await writeFile(join(dir, 'algorithm.js'), 'function run(IN){return {saida:IN.valor*2}}'); engine.save(node); engine.start({}); const first = await finish(engine);
    engine.move([{ id: node.id, position: { x: 500, y: 500 } }]); expect(engine.snapshot().run?.stale).toBe(false);
    engine.start({}); expect((await finish(engine)).run?.results[node.id]?.status).toBe('cached');
    await writeFile(join(dir, 'algorithm.js'), 'function run(IN){return {saida:IN.valor*3}}'); engine.start({}); const changed = await finish(engine); expect(changed.run?.results[node.id]?.status).toBe('success'); expect(engine.inspect(node.id, 'saida').value).toBe(6);
    expect(engine.compare(first.run!.id, changed.run!.id).changes[0]?.codeChanged).toBe(true);
  });
  it('executa grafo 3D, testa algoritmo, reutiliza cache e invalida apenas dependentes', async () => {
    const { engine } = await setup();
    engine.example({ x: 0, y: 0 }); engine.start({});
    const first = await finish(engine);
    expect(first.run?.status).toBe('success');
    const input = first.graph.nodes.find((node) => node.kind === 'input')!;
    const code = first.graph.nodes.find((node) => node.kind === 'code')!;
    const view = first.graph.nodes.find((node) => node.kind === 'view')!;
    expect(engine.inspect(view.id, 'valor').value).toMatchObject({ units: 'm', items: [{ kind: 'line', points: expect.any(Array) }] });
    expect((await engine.test(code.id)).passed).toBe(1);
    engine.start({}); const cached = await finish(engine);
    expect(Object.values(cached.run!.results).every((result) => result.status === 'cached')).toBe(true);
    input.config.value = 4; engine.save(input); expect(engine.snapshot().run?.stale).toBe(true);
    engine.start({}); const updated = await finish(engine);
    expect(updated.run?.status).toBe('success');
    expect(engine.compare(first.run!.id, updated.run!.id).changes).toHaveLength(3);
    expect(engine.history().runs).toHaveLength(3);
  }, 15000);
  it('separa preview da escrita e rejeita conflitos no arquivo de destino', async () => {
    const { engine, dir } = await setup();
    const node = defaultFlowNode('input', randomUUID()); engine.save(node); engine.start({}); await finish(engine);
    const preview = engine.exportPreview({ nodeId: node.id, port: 'valor', path: 'resultado.json' });
    await expect(readFile(join(dir, 'resultado.json'))).rejects.toThrow();
    engine.exportApply({ nodeId: node.id, port: 'valor', ...preview });
    expect(await readFile(join(dir, 'resultado.json'), 'utf8')).toContain('1');
    expect(() => engine.exportApply({ nodeId: node.id, port: 'valor', ...preview })).toThrow();
    expect(() => engine.exportPreview({ nodeId: node.id, port: 'valor', path: '../escape.json' })).toThrow();
  });
  it('valida portas, bloqueia ciclos e impede executar consumidores após falha', async () => {
    const { engine } = await setup();
    const source = defaultFlowNode('input', randomUUID()); const target = defaultFlowNode('code', randomUUID());
    target.config.language = 'javascript'; target.config.code = 'function run(IN) { return {saida: "bad"}; }';
    engine.save(source); engine.save(target); engine.connect({ from: source.id, output: 'valor', to: target.id, input: 'valor' });
    const consumer = defaultFlowNode('view', randomUUID()); engine.save(consumer); engine.connect({ from: target.id, output: 'saida', to: consumer.id, input: 'valor' });
    expect(() => engine.connect({ from: consumer.id, output: 'valor', to: target.id, input: 'valor' })).toThrow();
    engine.start({}); const snapshot = await finish(engine);
    expect(snapshot.run?.results[target.id]?.status).toBe('error'); expect(snapshot.run?.results[consumer.id]?.status).toBe('skipped');
    target.inputs.push(flowPortSchema.parse({ name: 'texto', type: 'string' })); engine.save(target);
    expect(() => engine.connect({ from: source.id, output: 'valor', to: target.id, input: 'texto' })).toThrow(/incompat/);
  });
  it('encerra algoritmo infinito ao cancelar sem deixar worker vivo', async () => {
    const pids: number[][] = []; const pool = new FlowWorkerPool({ onPids: (list) => pids.push(list) });
    cleanup.push(() => pool.close()); const controller = new AbortController();
    const run = pool.execute({ language: 'javascript', cwd: process.cwd(), code: 'while(true) {}', inputs: {}, timeoutMs: 10000 }, controller.signal);
    const rejected = expect(run).rejects.toThrow(/cancelada/);
    for (let i = 0; i < 100 && !pids.some((list) => list.length); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(); await rejected; await pool.close(); expect(pids.at(-1)).toEqual([]);
  });
});
