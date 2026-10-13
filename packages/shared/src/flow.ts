import { z } from 'zod';

const finite = z.number().finite();
export const flowPositionSchema = z.object({ x: finite, y: finite });
export const flowSizeSchema = z.object({ width: finite.positive(), height: finite.positive() });
export const flowKindSchema = z.enum(['input', 'file', 'agent', 'code', 'validate', 'test', 'view', 'output']);
export const flowDataTypeSchema = z.enum(['any', 'number', 'string', 'boolean', 'json', 'geometry', 'file']);
export type FlowDataType = z.infer<typeof flowDataTypeSchema>;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), finite, z.string(), z.array(jsonValueSchema), z.record(jsonValueSchema)]));
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) ?? '').length;
const portNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/).refine((name) => !['__proto__', 'prototype', 'constructor'].includes(name), 'Nome de porta reservado.');
export const flowPortSchema = z.object({
  name: portNameSchema, label: z.string().max(80).default(''), type: flowDataTypeSchema.default('json'),
  required: z.boolean().default(true), maxBytes: z.number().int().min(1).max(4 * 1024 * 1024).default(65536),
  unit: z.string().max(24).default(''), schema: jsonValueSchema.nullable().default(null), defaultValue: jsonValueSchema.default(null),
});
export type FlowPort = z.infer<typeof flowPortSchema>;
const testCaseSchema = z.object({ title: z.string().min(1).max(120), inputs: z.record(jsonValueSchema), expected: z.record(jsonValueSchema) });
export const flowConfigSchema = z.object({
  value: jsonValueSchema.default(null), language: z.enum(['python', 'javascript']).default('python'),
  code: z.string().max(65536).default(''), scriptPath: z.string().max(1024).default(''),
  pythonExecutable: z.string().max(1024).default('python'), dependencies: z.array(z.string().max(1024)).max(32).default([]),
  deterministic: z.boolean().default(true), timeoutMs: z.number().int().min(100).max(300000).default(10000),
  terminalId: z.string().uuid().nullable().default(null), instruction: z.string().max(16000).default(''),
  allowedFiles: z.array(z.string().max(1024)).max(64).default([]),
  filePath: z.string().max(1024).default(''), fileFormat: z.enum(['reference', 'json', 'text', 'csv']).default('reference'),
  minimum: finite.nullable().default(null), maximum: finite.nullable().default(null),
  expected: jsonValueSchema.default(null), tolerance: finite.nonnegative().default(0.000001), tests: z.array(testCaseSchema).max(50).default([]),
  view: z.enum(['table', 'chart', '3d']).default('table'), exportPath: z.string().max(1024).default('resultados/saida.json'),
});
export const flowNodeSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(120), kind: flowKindSchema,
  position: flowPositionSchema, size: flowSizeSchema.default({ width: 280, height: 220 }),
  inputs: z.array(flowPortSchema).max(16), outputs: z.array(flowPortSchema).max(16), config: flowConfigSchema,
}).superRefine((node, ctx) => {
  if (['input', 'file'].includes(node.kind) && node.inputs.length) ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Nós de entrada e arquivo não recebem portas de entrada.' });
  if (['validate', 'test', 'view', 'output'].includes(node.kind) && node.inputs.length !== 1) ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Esta etapa recebe uma única entrada; use um algoritmo para combinar valores.' });
  for (const side of ['inputs', 'outputs'] as const) {
    const names = new Set<string>();
    node[side].forEach((port, index) => { if (names.has(port.name)) ctx.addIssue({ code: 'custom', path: [side, index, 'name'], message: 'Porta repetida.' }); names.add(port.name); });
  }
  if (jsonBytes(node) > 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'O nó excede 1 MiB. Use referência a arquivo para dados grandes.' });
});
export type FlowNode = z.infer<typeof flowNodeSchema>;
export const flowConnectionSchema = z.object({ id: z.string().uuid(), from: z.string().uuid(), output: portNameSchema, to: z.string().uuid(), input: portNameSchema });
export type FlowConnection = z.infer<typeof flowConnectionSchema>;
export const flowGraphSchema = z.object({
  nodes: z.array(flowNodeSchema).max(200).default([]), connections: z.array(flowConnectionSchema).max(1000).default([]), autoRun: z.boolean().default(false),
}).superRefine((graph, ctx) => {
  const ids = new Set<string>();
  graph.nodes.forEach((node, index) => { if (ids.has(node.id)) ctx.addIssue({ code: 'custom', path: ['nodes', index], message: 'ID de nó repetido.' }); ids.add(node.id); });
  const inputs = new Set<string>(), edgeIds = new Set<string>();
  graph.connections.forEach((edge, index) => {
    const source = graph.nodes.find((node) => node.id === edge.from), target = graph.nodes.find((node) => node.id === edge.to);
    if (!source?.outputs.some((port) => port.name === edge.output) || !target?.inputs.some((port) => port.name === edge.input)) ctx.addIssue({ code: 'custom', path: ['connections', index], message: 'Conexão com nó ou porta inexistente.' });
    if (edge.from === edge.to) ctx.addIssue({ code: 'custom', path: ['connections', index], message: 'Um nó não pode alimentar a si mesmo.' });
    const key = `${edge.to}:${edge.input}`;
    if (inputs.has(key) || edgeIds.has(edge.id)) ctx.addIssue({ code: 'custom', path: ['connections', index], message: 'Conexão duplicada ou entrada já conectada.' });
    inputs.add(key); edgeIds.add(edge.id);
  });
  const visited = new Set<string>(), stack = new Set<string>();
  function visit(id: string): boolean {
    if (stack.has(id)) return false;
    if (visited.has(id)) return true;
    stack.add(id);
    for (const edge of graph.connections.filter((edge) => edge.from === id)) if (!visit(edge.to)) return false;
    stack.delete(id); visited.add(id); return true;
  }
  if (graph.nodes.some((node) => !visit(node.id))) ctx.addIssue({ code: 'custom', path: ['connections'], message: 'O fluxo de dados contém um ciclo.' });
  if (jsonBytes(graph) > 8 * 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'O grafo excede 8 MiB. Use arquivos como referência.' });
});
export type FlowGraph = z.infer<typeof flowGraphSchema>;

const pointSchema = z.tuple([finite, finite, finite]);
const geometryItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('points'), id: z.string().max(120), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#7aa7ff'), points: z.array(pointSchema).max(100000) }),
  z.object({ kind: z.literal('line'), id: z.string().max(120), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4cc38a'), points: z.array(pointSchema).min(2).max(100000) }),
  z.object({ kind: z.literal('mesh'), id: z.string().max(120), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#b29aff'), vertices: z.array(pointSchema).max(100000), faces: z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()])).max(200000) }),
]);
export const flowGeometrySchema = z.object({ units: z.enum(['m', 'cm', 'mm', 'ft']).default('m'), origin: pointSchema.default([0, 0, 0]), transform: z.array(finite).length(16).optional(), items: z.array(geometryItemSchema).max(1000) }).superRefine((geometry, ctx) => {
  let points = 0;
  geometry.items.forEach((item, index) => {
    points += item.kind === 'mesh' ? item.vertices.length : item.points.length;
    if (item.kind === 'mesh' && item.faces.some((face) => face.some((vertex) => vertex >= item.vertices.length))) ctx.addIssue({ code: 'custom', path: ['items', index], message: 'Face com índice de vértice inexistente.' });
  });
  if (points > 100000) ctx.addIssue({ code: 'custom', message: 'A prévia admite até 100 mil pontos/vértices. Simplifique a geometria.' });
});
export type FlowGeometry = z.infer<typeof flowGeometrySchema>;
export const flowArtifactSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), preview: z.string().max(2048), type: flowDataTypeSchema });
export type FlowArtifact = z.infer<typeof flowArtifactSchema>;
export const flowNodeResultSchema = z.object({
  status: z.enum(['idle', 'queued', 'running', 'success', 'cached', 'error', 'cancelled', 'skipped', 'stale']),
  outputs: z.record(flowArtifactSchema), message: z.string().max(8192).default(''), logs: z.string().max(8192).default(''), durationMs: finite.nonnegative().default(0),
  codeHash: z.string().default(''), runtime: z.string().default(''),
});
export type FlowNodeResult = z.infer<typeof flowNodeResultSchema>;
export const flowRunSchema = z.object({
  id: z.string().uuid(), revision: z.string(), startedAt: z.string(), finishedAt: z.string().nullable(),
  status: z.enum(['running', 'success', 'error', 'cancelled']), stale: z.boolean().default(false),
  results: z.record(flowNodeResultSchema), agentCalls: z.number().int().nonnegative(), sentBytes: z.number().int().nonnegative(), receivedBytes: z.number().int().nonnegative(),
});
export type FlowRun = z.infer<typeof flowRunSchema>;
export const flowTestReportSchema = z.object({ nodeId: z.string().uuid(), passed: z.number().int(), failed: z.number().int(), cases: z.array(z.object({ title: z.string(), passed: z.boolean(), message: z.string(), durationMs: finite.nonnegative() })) });
export type FlowTestReport = z.infer<typeof flowTestReportSchema>;
export const flowSnapshotSchema = z.object({ graph: flowGraphSchema, run: flowRunSchema.nullable(), tests: flowTestReportSchema.nullable() });
export type FlowSnapshot = z.infer<typeof flowSnapshotSchema>;
export const flowCanvasId = (id: string) => `flow:${id}`;
export const FLOW_LABELS: Record<FlowNode['kind'], string> = { input: 'Entrada', file: 'Arquivo', agent: 'Agente', code: 'Algoritmo', validate: 'Validação', test: 'Teste', view: 'Visualização', output: 'Saída' };

export function defaultFlowNode(kind: FlowNode['kind'], id: string, position = { x: 80, y: 140 }): FlowNode {
  const port = (name: string, type: FlowDataType = 'json') => flowPortSchema.parse({ name, label: name, type });
  let inputs: FlowPort[] = [], outputs = [port('saida')];
  const config = flowConfigSchema.parse({});
  if (kind === 'input') { outputs = [port('valor', 'number')]; config.value = 1; }
  if (kind === 'file') outputs = [port('arquivo', 'file')];
  if (kind === 'code') { inputs = [port('valor', 'number')]; outputs = [port('saida', 'number')]; config.code = 'def run(IN):\n    return {"saida": IN["valor"] * 2}\n'; }
  if (kind === 'agent') { inputs = [port('entrada')]; config.deterministic = false; config.timeoutMs = 300000; }
  if (['validate', 'test', 'view', 'output'].includes(kind)) { inputs = [port('valor', 'any')]; outputs = [port('valor', 'any')]; }
  return flowNodeSchema.parse({ id, title: FLOW_LABELS[kind], kind, position, size: { width: 280, height: 220 }, inputs, outputs, config });
}
