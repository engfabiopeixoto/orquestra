import { describe, expect, it } from 'vitest';
import {
  exitCodeFor,
  isMethodName,
  OrqError,
  parseParams,
  parseResult,
  requestSchema,
  responseSchema,
} from '../src/index.js';

describe('exitCodeFor', () => {
  it('mapeia cada código para o código de saída da spec', () => {
    expect(exitCodeFor('USAGE')).toBe(2);
    expect(exitCodeFor('NOT_FOUND')).toBe(3);
    expect(exitCodeFor('NOT_CONNECTED')).toBe(3);
    expect(exitCodeFor('APP_UNAVAILABLE')).toBe(4);
    expect(exitCodeFor('INVALID_TOKEN')).toBe(5);
    expect(exitCodeFor('PROMPT_FAILED')).toBe(6);
  });
});

describe('parseParams', () => {
  it('aceita parâmetros válidos de prompt', () => {
    expect(parseParams('prompt', { target: 'B', text: 'oi', timeoutMs: 1000 })).toEqual({
      target: 'B',
      text: 'oi',
      timeoutMs: 1000,
    });
  });

  it('recusa parâmetros inválidos com OrqError USAGE', () => {
    try {
      parseParams('prompt', { target: '', text: 'oi', timeoutMs: 1000 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OrqError);
      expect((error as OrqError).code).toBe('USAGE');
    }
  });

  it('aceita qualquer payload no hook', () => {
    expect(parseParams('hook', { agent: 'agy', event: 'Stop', payload: { a: [1] } }).payload).toEqual({ a: [1] });
  });
});

describe('parseResult', () => {
  it('distingue resposta pronta de pendente no prompt', () => {
    expect(parseResult('prompt', { status: 'pending', askId: 'x' })).toEqual({ status: 'pending', askId: 'x' });
    expect(parseResult('prompt', { status: 'answered', askId: 'x', answer: 'ok' }).status).toBe('answered');
  });

  it('aceita falha no result', () => {
    expect(parseResult('result', { status: 'failed', reason: 'interrompido' })).toEqual({ status: 'failed', reason: 'interrompido' });
  });
});

describe('isMethodName', () => {
  it('reconhece os métodos e recusa o resto', () => {
    expect(isMethodName('note.write')).toBe(true);
    expect(isMethodName('ask')).toBe(false);
  });
});

describe('envelopes', () => {
  it('valida requisição e resposta', () => {
    expect(requestSchema.parse({ v: 1, id: 'a', token: 't', method: 'peers', params: {} }).method).toBe('peers');
    expect(responseSchema.parse({ id: 'a', ok: false, error: { code: 'NOT_FOUND', message: 'x' } }).ok).toBe(false);
  });
});
