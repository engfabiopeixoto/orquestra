import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { silentLogger } from '../../core/src/log.js';
import { startPipeServer } from '../../core/src/pipe-server.js';
import { runMcp } from '../src/mcp.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

it('expõe ferramentas nativas e entrega prompt pelo pipe autenticado', async () => {
  const pipePath = `\\\\.\\pipe\\orq-mcp-test-${randomBytes(8).toString('hex')}`;
  let received: unknown;
  const server = await startPipeServer({ pipePath, log: silentLogger(), authenticate: (token) => token === 'secret-sentinel' ? { session: 'codex-1' } : undefined,
    dispatch: async (method, params, caller) => {
      if (method === 'whoami') return { name: caller.session, agent: 'codex' };
      if (method === 'prompt') { received = params; return { status: 'answered', askId: 'ping', answer: 'PONG' }; }
      if (method === 'quality') {
        received = params;
        return {
          version: 1,
          dir: 'E:/proj',
          measuredAt: '2026-11-20T12:00:00.000Z',
          durationMs: 10,
          language: 'js-ts',
          limits: { files: 1, skippedLarge: 0, truncated: false },
          metrics: [
            { id: 'size', signal: 'bad', value: 700, delta: 100 },
            { id: 'complexity', signal: 'ok', value: 2, delta: 0 },
            { id: 'dependencies', signal: 'ok', value: 0, delta: 0 },
            { id: 'coverage', signal: 'missing', value: null, delta: null },
            { id: 'mutation', signal: 'missing', value: null, delta: null },
          ],
          files: [],
          functions: [],
          cycles: [],
          hotspots: [],
          changed: [{ path: 'src/big.ts', kind: 'file-over-limit', detail: 'Passou de 350 linhas (700 linhas).' }],
          coverage: null,
          mutation: null,
        };
      }
      if (method === 'portal.list') return { portals: [{ id: 'portal-1', title: 'Browser' }] };
      if (method === 'usage') { received = params; return { providers: [{ provider: 'claude', usage: null, error: null }] }; }
      throw new Error('Unexpected method');
    } });
  const input = new PassThrough();
  const responses = new Map<number, Record<string, any>>();
  let output = '';
  const running = runMcp({ stdin: input, stdout: { write: (line) => { output += line; const message = JSON.parse(line); responses.set(message.id, message); } }, stderr: { write: () => {} }, env: { ORQ_PIPE: pipePath, ORQ_TOKEN: 'secret-sentinel' } });
  cleanup = async () => { input.end(); await running; await server.close(); };
  const request = async (id: number, method: string, params: object = {}) => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + 2000;
    while (!responses.has(id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(responses.has(id)).toBe(true);
    return responses.get(id)!;
  };
  expect((await request(1, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name).toBe('orquestra');
  const tools = (await request(2, 'tools/list')).result.tools;
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['whoami', 'peers', 'prompt', 'read', 'regent_link', 'regent_restart', 'regent_unload', 'regent_load', 'portal_list', 'portal_check', 'portal_navigate', 'portal_click', 'portal_type', 'portal_screenshot', 'usage', 'quality']));
  const qualityTool = tools.find((tool: { name: string; annotations?: { readOnlyHint?: boolean } }) => tool.name === 'quality');
  expect(qualityTool?.annotations?.readOnlyHint).toBe(true);
  const promptTool = tools.find((tool: { name: string; inputSchema?: { properties?: Record<string, { type?: string; description?: string }> } }) => tool.name === 'prompt');
  expect(promptTool?.inputSchema?.properties?.quality).toEqual({
    type: 'boolean',
    description: 'anexa a variação de qualidade dos arquivos alterados; use ao pedir revisão',
  });
  expect(JSON.parse((await request(3, 'tools/call', { name: 'whoami', arguments: {} })).result.content[0].text)).toEqual({ name: 'codex-1', agent: 'codex' });
  const answer = await request(4, 'tools/call', { name: 'prompt', arguments: { target: 'agy-1', text: 'PING' } });
  expect(JSON.parse(answer.result.content[0].text).answer).toBe('PONG');
  expect(received).toEqual({ target: 'agy-1', text: 'PING', timeoutMs: 480000 });
  expect(output).not.toContain('secret-sentinel');
  const invalid = await request(5, 'tools/call', { name: 'prompt', arguments: { target: 'agy-1' } });
  expect(invalid.result.isError).toBe(true);
  expect(JSON.parse((await request(6, 'tools/call', { name: 'portal_list', arguments: {} })).result.content[0].text).portals[0].id).toBe('portal-1');
  const usageRes = await request(7, 'tools/call', { name: 'usage', arguments: { provider: 'claude' } });
  expect(JSON.parse(usageRes.result.content[0].text)).toEqual({ providers: [{ provider: 'claude', usage: null, error: null }] });
  expect(received).toEqual({ provider: 'claude' });
  const reviewAnswer = await request(8, 'tools/call', { name: 'prompt', arguments: { target: 'revisor', text: 'Revise', quality: true } });
  expect(JSON.parse(reviewAnswer.result.content[0].text).answer).toBe('PONG');
  expect((received as { text: string }).text).toContain('Revise\n\n--- Qualidade (orq quality --changed, anexado pelo Orquestra) ---\n');
  expect((received as { text: string }).text).toContain('src/big.ts');
  expect((received as { quality?: unknown }).quality).toBeUndefined();
});

it('MCP prompt com quality trata timeout, falha, tipo inválido e cancelamento externo', async () => {
  const pipePath = `\\\\.\\pipe\\orq-mcp-q-${randomBytes(8).toString('hex')}`;
  let qualityMode: 'fail' | 'hang' = 'fail';
  let lastPrompt: { text: string; timeoutMs: number } | undefined;
  let promptCount = 0;
  let releaseHang: (() => void) | undefined;
  const server = await startPipeServer({
    pipePath,
    log: silentLogger(),
    authenticate: (token) => (token === 'tok' ? { session: 'codex-1' } : undefined),
    dispatch: async (method, params) => {
      if (method === 'quality') {
        if (qualityMode === 'fail') throw new Error('falha quality');
        await new Promise<void>((resolve) => {
          releaseHang = resolve;
          setTimeout(resolve, 600);
        });
        return {};
      }
      if (method === 'prompt') {
        promptCount += 1;
        lastPrompt = params as { text: string; timeoutMs: number };
        return { status: 'answered', askId: `p-${promptCount}`, answer: 'OK' };
      }
      throw new Error('Unexpected method');
    },
  });
  const input = new PassThrough();
  const responses = new Map<number, Record<string, any>>();
  let stderr = '';
  const running = runMcp({
    stdin: input,
    stdout: { write: (line) => { const msg = JSON.parse(line); if (msg.id !== undefined && msg.id !== null) responses.set(msg.id, msg); } },
    stderr: { write: (text) => { stderr += text; } },
    env: { ORQ_PIPE: pipePath, ORQ_TOKEN: 'tok' },
  });
  cleanup = async () => { releaseHang?.(); input.end(); await running; await server.close(); };
  const request = async (id: number, method: string, params: object = {}) => {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const deadline = Date.now() + 2000;
    while (!responses.has(id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(responses.has(id)).toBe(true);
    return responses.get(id)!;
  };

  // quality não booleano -> USAGE
  const badType = await request(1, 'tools/call', { name: 'prompt', arguments: { target: 'revisor', text: 'Oi', quality: 'sim' } });
  expect(badType.result.isError).toBe(true);
  expect(badType.result.content[0].text).toContain('USAGE');

  // falha em quality -> envia prompt sem bloco, sem isError, avisa stderr
  const failedQuality = await request(2, 'tools/call', { name: 'prompt', arguments: { target: 'revisor', text: 'Sem bloco', quality: true } });
  expect(failedQuality.result.isError).toBeUndefined();
  expect(lastPrompt?.text).toBe('Sem bloco');
  expect(stderr.length).toBeGreaterThan(0);

  // timeout em quality -> aborta medição, envia prompt sem bloco e desconta tempo do timeoutMs
  stderr = '';
  qualityMode = 'hang';
  const timedOutQuality = await request(3, 'tools/call', { name: 'prompt', arguments: { target: 'revisor', text: 'Timeout curto', timeoutMs: 240, quality: true } });
  expect(timedOutQuality.result.isError).toBeUndefined();
  expect(lastPrompt?.text).toBe('Timeout curto');
  expect(lastPrompt?.timeoutMs).toBeGreaterThan(0);
  expect(lastPrompt?.timeoutMs).toBeLessThan(240);
  expect(stderr.length).toBeGreaterThan(0);

  // cancelamento externo durante quality -> sem aviso falso no stderr e sem chamar prompt
  stderr = '';
  const beforePrompts = promptCount;
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'prompt', arguments: { target: 'revisor', text: 'Cancelar', timeoutMs: 2000, quality: true } } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(responses.has(4)).toBe(false);
  expect(promptCount).toBe(beforePrompts);
  expect(stderr).toBe('');
});
