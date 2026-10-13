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
      if (method === 'portal.list') return { portals: [{ id: 'portal-1', title: 'Browser' }] };
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
  expect(tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['whoami', 'peers', 'prompt', 'read', 'regent_link', 'portal_list', 'portal_check', 'portal_navigate', 'portal_click', 'portal_type', 'portal_screenshot']));
  expect(JSON.parse((await request(3, 'tools/call', { name: 'whoami', arguments: {} })).result.content[0].text)).toEqual({ name: 'codex-1', agent: 'codex' });
  const answer = await request(4, 'tools/call', { name: 'prompt', arguments: { target: 'agy-1', text: 'PING' } });
  expect(JSON.parse(answer.result.content[0].text).answer).toBe('PONG');
  expect(received).toEqual({ target: 'agy-1', text: 'PING', timeoutMs: 480000 });
  expect(output).not.toContain('secret-sentinel');
  const invalid = await request(5, 'tools/call', { name: 'prompt', arguments: { target: 'agy-1' } });
  expect(invalid.result.isError).toBe(true);
  expect(JSON.parse((await request(6, 'tools/call', { name: 'portal_list', arguments: {} })).result.content[0].text).portals[0].id).toBe('portal-1');
});
