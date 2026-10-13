import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defaultFlowNode, flowGeometrySchema, flowGraphSchema, flowPortSchema } from '../src/flow.js';
import { compatiblePorts, equalWithTolerance, validateFlowValue } from '../src/flow-contract.js';

describe('contratos do fluxo', () => {
  it('valida tipos, campos, limites e tamanho antes de transmitir conteúdo', () => {
    const port = flowPortSchema.parse({ name: 'dados', type: 'json', schema: { type: 'object', required: ['valor'], additionalProperties: false, properties: { valor: { type: 'integer', minimum: 0, maximum: 10 } } } });
    expect(validateFlowValue(port, { valor: 2 })).toEqual({ valor: 2 });
    for (const value of [{}, { valor: 11 }, { valor: 1.5 }, { valor: 1, extra: true }, null, { valor: Infinity }]) expect(() => validateFlowValue(port, value)).toThrow();
    expect(() => validateFlowValue(flowPortSchema.parse({ name: 'texto', type: 'string', maxBytes: 3 }), 'áá')).toThrow(/excede/);
    expect(() => validateFlowValue(flowPortSchema.parse({ name: 'dados', schema: { properties: { opcional: { oneOf: [] } } } }), {})).toThrow(/não suportada/);
    expect(() => validateFlowValue(flowPortSchema.parse({ name: 'dados', schema: { enum: 'invalido' } }), {})).toThrow(/lista/);
  });
  it('mantém direção, uma conexão por entrada, referências válidas e ausência de ciclos', () => {
    const a = defaultFlowNode('code', randomUUID()), b = defaultFlowNode('code', randomUUID());
    const edge = { id: randomUUID(), from: a.id, output: 'saida', to: b.id, input: 'valor' };
    expect(flowGraphSchema.safeParse({ nodes: [a, b], connections: [edge] }).success).toBe(true);
    expect(flowGraphSchema.safeParse({ nodes: [a, b], connections: [edge, { ...edge, id: randomUUID() }] }).success).toBe(false);
    expect(flowGraphSchema.safeParse({ nodes: [a, b], connections: [edge, { id: randomUUID(), from: b.id, output: 'saida', to: a.id, input: 'valor' }] }).success).toBe(false);
    expect(flowGraphSchema.safeParse({ nodes: [a], connections: [edge] }).success).toBe(false);
  });
  it('confere unidades e índices de faces antes da prévia 3D', () => {
    const geometry = { units: 'mm', items: [{ kind: 'mesh', id: 'triangle', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]] }] };
    expect(flowGeometrySchema.safeParse(geometry).success).toBe(true);
    expect(() => validateFlowValue(flowPortSchema.parse({ name: 'geometry', type: 'geometry', unit: 'm' }), geometry)).toThrow(/unidade/);
    expect(flowGeometrySchema.safeParse({ ...geometry, items: [{ ...geometry.items[0], faces: [[0, 1, 3]] }] }).success).toBe(false);
    expect(compatiblePorts(flowPortSchema.parse({ name: 'a', type: 'geometry', unit: 'm' }), flowPortSchema.parse({ name: 'b', type: 'geometry', unit: 'mm' }))).toBe(false);
  });
  it('compara objetos independentemente da ordem das chaves com tolerância numérica', () => {
    expect(equalWithTolerance({ a: [1, 2], b: true }, { b: true, a: [1.000001, 2] }, 0.00001)).toBe(true);
    expect(equalWithTolerance({ a: 1 }, { a: 1.1 }, 0.001)).toBe(false);
    expect(flowPortSchema.safeParse({ name: '__proto__' }).success).toBe(false);
  });
});
