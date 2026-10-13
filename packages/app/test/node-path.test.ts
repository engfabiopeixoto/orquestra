import { describe, expect, it } from 'vitest';
import { resolveNodePath } from '../src/main/node-path';

describe('resolveNodePath', () => {
  it('usa ORQ_NODE_PATH quando o arquivo existe', () => {
    expect(resolveNodePath({ env: { ORQ_NODE_PATH: 'C:/n/node.exe' }, where: () => null, exists: () => true })).toBe('C:/n/node.exe');
  });

  it('ORQ_NODE_PATH apontando para nada é erro claro', () => {
    expect(() => resolveNodePath({ env: { ORQ_NODE_PATH: 'C:/x/node.exe' }, where: () => null, exists: () => false })).toThrow(/não existe/);
  });

  it('cai no where e pega o primeiro node.exe', () => {
    expect(resolveNodePath({ env: {}, where: () => 'C:\\a\\node.cmd\r\nC:\\b\\node.exe\r\n' })).toBe('C:\\b\\node.exe');
  });

  it('sem Node no sistema, explica o que fazer', () => {
    expect(() => resolveNodePath({ env: {}, where: () => null })).toThrow(/Node 22 não encontrado/);
  });
});
