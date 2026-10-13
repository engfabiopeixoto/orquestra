import { flowGeometrySchema, jsonBytes, jsonValueSchema, type FlowPort, type JsonValue } from './flow.js';

const SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'additionalProperties', 'description', 'title']);
export function validateFlowSchema(raw: JsonValue, path = 'schema', depth = 0): void {
  if (depth > 24) throw new Error(`${path}: contrato muito profundo.`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path}: schema deve ser um objeto JSON.`);
  for (const [key, value] of Object.entries(raw)) {
    if (!SCHEMA_KEYS.has(key)) throw new Error(`${path}: palavra de contrato não suportada: ${key}.`);
    if (key === 'type' && (typeof value !== 'string' || !['null', 'boolean', 'number', 'integer', 'string', 'array', 'object'].includes(value))) throw new Error(`${path}.type: tipo não suportado.`);
    if (['title', 'description'].includes(key) && typeof value !== 'string') throw new Error(`${path}.${key}: forneça texto.`);
    if (['minimum', 'maximum'].includes(key) && typeof value !== 'number') throw new Error(`${path}.${key}: forneça um número.`);
    if (['minLength', 'maxLength', 'minItems', 'maxItems'].includes(key) && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) throw new Error(`${path}.${key}: forneça um inteiro não negativo.`);
    if (key === 'additionalProperties' && typeof value !== 'boolean') throw new Error(`${path}.${key}: forneça true ou false.`);
    if (key === 'enum' && (!Array.isArray(value) || !value.length)) throw new Error(`${path}.enum: forneça uma lista não vazia.`);
    if (key === 'required' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) throw new Error(`${path}.required: forneça uma lista de nomes.`);
    if (key === 'items') validateFlowSchema(value, `${path}.items`, depth + 1);
    if (key === 'properties') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}.properties: forneça um objeto de schemas.`);
      for (const [name, nested] of Object.entries(value)) validateFlowSchema(nested, `${path}.${name}`, depth + 1);
    }
  }
}

function checkSchema(value: JsonValue, raw: JsonValue, path: string, depth = 0): void {
  if (depth > 24) throw new Error(`${path}: contrato muito profundo.`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path}: schema deve ser um objeto JSON.`);
  const schema = raw as Record<string, JsonValue>;
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) throw new Error(`${path}: palavra de contrato não suportada: ${key}.`);
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value === 'object' ? 'object' : typeof value;
  if (schema.type && schema.type !== type && !(schema.type === 'integer' && typeof value === 'number' && Number.isInteger(value))) throw new Error(`${path}: esperado ${schema.type}, recebido ${type}.`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => equalWithTolerance(item, value, 0))) throw new Error(`${path}: valor fora das opções permitidas.`);
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) throw new Error(`${path}: valor abaixo de ${schema.minimum}.`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) throw new Error(`${path}: valor acima de ${schema.maximum}.`);
  }
  const length = typeof value === 'string' || Array.isArray(value) ? value.length : null;
  if (length !== null) {
    const min = Array.isArray(value) ? schema.minItems : schema.minLength, max = Array.isArray(value) ? schema.maxItems : schema.maxLength;
    if (typeof min === 'number' && length < min) throw new Error(`${path}: conteúdo menor que ${min}.`);
    if (typeof max === 'number' && length > max) throw new Error(`${path}: conteúdo maior que ${max}.`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => checkSchema(item, schema.items!, `${path}[${index}]`, depth + 1));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const key of schema.required) if (typeof key === 'string' && !Object.hasOwn(value, key)) throw new Error(`${path}: campo obrigatório ausente: ${key}.`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) checkSchema(item, properties[key]!, `${path}.${key}`, depth + 1);
      else if (schema.additionalProperties === false) throw new Error(`${path}: campo não permitido: ${key}.`);
    }
  }
}

export function validateFlowValue(port: FlowPort, value: unknown): JsonValue {
  if (port.schema !== null) validateFlowSchema(port.schema, port.name);
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${port.label || port.name}: forneça dados JSON válidos e números finitos.`);
  const data = parsed.data;
  if (data === null && port.required) throw new Error(`${port.label || port.name}: entrada/saída obrigatória ausente.`);
  if (data !== null) {
    if (['number', 'string', 'boolean'].includes(port.type) && typeof data !== port.type) throw new Error(`${port.name}: esperado ${port.type}.`);
    if (port.type === 'geometry') {
      const geometry = flowGeometrySchema.safeParse(data);
      if (!geometry.success) throw new Error(`${port.name}: geometria inválida: ${geometry.error.issues[0]?.message}`);
      if (port.unit && geometry.data.units !== port.unit) throw new Error(`${port.name}: unidade ${geometry.data.units} incompatível com ${port.unit}.`);
    }
    if (port.type === 'file' && (typeof data !== 'object' || Array.isArray(data) || typeof data.path !== 'string' || typeof data.hash !== 'string')) throw new Error(`${port.name}: esperado uma referência de arquivo com path e hash.`);
    if (port.schema !== null) checkSchema(data, port.schema, port.name);
  }
  if (jsonBytes(data) > port.maxBytes) throw new Error(`${port.name}: conteúdo excede ${port.maxBytes} bytes. Use referência a arquivo ou aumente o limite da porta.`);
  return data;
}
export function compatiblePorts(output: FlowPort, input: FlowPort): boolean {
  return (input.type === 'any' || input.type === 'json' || input.type === output.type) && (!input.unit || !output.unit || input.unit === output.unit);
}
export function equalWithTolerance(a: JsonValue, b: JsonValue, tolerance: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tolerance;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equalWithTolerance(value, b[index]!, tolerance));
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equalWithTolerance(a[key]!, b[key]!, tolerance));
  }
  return a === b;
}
