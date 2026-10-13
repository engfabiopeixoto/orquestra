import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { call, exitCodeFor, OrqError, parseArgs as parseSharedArgs, REGENT_COMMANDS, type ClientOptions } from '@orquestra/shared';
import { parseDuration } from './duration.js';
import { runMcp } from './mcp.js';

export type Io = {
  stdin: NodeJS.ReadableStream;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
};

type Output = { text: string; json: unknown };

const HELP = `Uso: orq <comando>
  whoami                         seu nome e tipo no canvas
  peers                          terminais conectados a você
  prompt <peer> <texto|->        envia um prompt e espera a resposta (--timeout 8m, --file <arquivo>)
  result <id>                    resposta de um prompt pendente
  read <peer> [--lines N]        tela atual de um terminal conectado
  note list | show <nota> | write <nota> <texto|-> | append <nota> <texto|->   (--file <arquivo>)
  portal list | check <id> [--chars N] | navigate <id> <url> | click <id> <seletor>
  portal type <id> <seletor> <texto|-> | scroll <id> <pixels> | screenshot <id>

Regente:
${REGENT_COMMANDS.map((command) => `  ${command.usage}\n      ${command.description}`).join('\n')}

Opção global: --json`;

const HOOK_STDIN_TIMEOUT_MS = 2000;
const HOOK_CALL_TIMEOUT_MS = 5000;

// O parseArgs do Node recusa valor que começa com "-" (--args "--model opus"); a forma --args=<valor> passa.
function normalizeArgv(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--args' && i + 1 < args.length) {
      result.push(`--args=${args[++i]}`);
    } else {
      result.push(args[i]!);
    }
  }
  return result;
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'mcp') return runMcp(io);
  if (command === 'hook') return runHook(rest, io);
  try {
    const { values, positionals } = parseArgs({
      args: normalizeArgv(rest),
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        timeout: { type: 'string' },
        file: { type: 'string' },
        lines: { type: 'string' },
        chars: { type: 'string' },
        agent: { type: 'string' },
        persona: { type: 'string' },
        args: { type: 'string' },
        cwd: { type: 'string' },
        'no-resume': { type: 'boolean' },
        global: { type: 'boolean' },
      },
    });
    const output = await execute(command, positionals, values, io);
    io.stdout.write(values.json ? `${JSON.stringify(output.json)}\n` : `${output.text}\n`);
    return 0;
  } catch (error) {
    const orqError = error instanceof OrqError ? error : new OrqError('USAGE', `${(error as Error).message}\n${HELP}`);
    io.stderr.write(`${orqError.message}\n`);
    return exitCodeFor(orqError.code);
  }
}

type Flags = {
  timeout?: string;
  file?: string;
  lines?: string;
  chars?: string;
  agent?: string;
  persona?: string;
  args?: string;
  cwd?: string;
  'no-resume'?: boolean;
  global?: boolean;
};

async function execute(
  command: string | undefined,
  args: string[],
  flags: Flags,
  io: Io,
): Promise<Output> {
  const client = clientFromEnv(io.env);
  switch (command) {
    case 'whoami': {
      const result = await call(client, 'whoami', {});
      return { text: `${result.name} (${result.agent})`, json: result };
    }
    case 'peers': {
      const result = await call(client, 'peers', {});
      const lines = result.peers.map((peer) => `${peer.name}\t${peer.agent}\t${peer.state}${peer.queued > 0 ? `\t${peer.queued} na fila` : ''}`);
      lines.push(...(result.portals ?? []).map((portal) => `${portal.id}\tnavegador\t${portal.title} (orq portal check ${portal.id})`));
      return { text: lines.length > 0 ? lines.join('\n') : 'Nenhum terminal conectado a você.', json: result };
    }
    case 'prompt': {
      const target = required(args[0], 'o terminal de destino');
      const text = await readText(args[1], flags.file, io.stdin);
      const result = await call(client, 'prompt', { target, text, timeoutMs: parseDuration(flags.timeout ?? '8m') });
      if (result.status === 'answered') return { text: result.answer, json: result };
      return { text: `pendente: id=${result.askId}; a resposta será entregue no seu terminal`, json: result };
    }
    case 'result': {
      const askId = required(args[0], 'o id do pedido');
      const result = await call(client, 'result', { askId });
      if (result.status === 'failed') throw new OrqError('PROMPT_FAILED', `O pedido ${askId} falhou: ${result.reason}.`);
      if (result.status === 'pending') return { text: `pendente: id=${askId}`, json: result };
      return { text: result.answer, json: result };
    }
    case 'read': {
      const target = required(args[0], 'o terminal a ler');
      const lines = flags.lines ? Number(flags.lines) : undefined;
      if (lines !== undefined && (!Number.isInteger(lines) || lines <= 0)) throw new OrqError('USAGE', '--lines precisa ser um número inteiro positivo.');
      const result = await call(client, 'read', { target, ...(lines ? { lines } : {}) });
      return { text: result.text, json: result };
    }
    case 'note':
      return executeNote(args, flags, client, io);
    case 'portal': {
      const action = args[0];
      if (action === 'list') { const result = await call(client, 'portal.list', {}); return { text: result.portals.map((portal) => `${portal.id}\t${portal.title}`).join('\n') || 'Nenhum navegador conectado. Conecte um portal a este terminal no canvas.', json: result }; }
      const id = required(args[1], 'o identificador do navegador (orq portal list)');
      let result: unknown;
      if (action === 'check') result = await call(client, 'portal.check', { id, ...(flags.chars ? { maxChars: Number(flags.chars) } : {}) });
      else if (action === 'navigate') result = await call(client, 'portal.navigate', { id, url: required(args[2], 'a URL HTTP/HTTPS') });
      else if (action === 'click') result = await call(client, 'portal.click', { id, selector: required(args[2], 'o seletor CSS') });
      else if (action === 'type') result = await call(client, 'portal.type', { id, selector: required(args[2], 'o seletor CSS'), text: await readText(args[3], flags.file, io.stdin) });
      else if (action === 'scroll') result = await call(client, 'portal.scroll', { id, y: Number(required(args[2], 'a distância em pixels')) });
      else if (action === 'screenshot') result = await call(client, 'portal.screenshot', { id });
      else throw new OrqError('USAGE', 'Use orq portal list, check, navigate, click, type, scroll ou screenshot.');
      return { text: JSON.stringify(result, null, 2), json: result };
    }
    case 'new': {
      const name = required(args[0], 'o nome do terminal');
      if (!flags.agent || !['claude', 'agy', 'codex', 'shell'].includes(flags.agent)) throw new OrqError('USAGE', 'Falta --agent (claude, agy, codex ou shell).');
      const result = await call(client, 'regent.new', {
        name,
        agent: flags.agent as 'claude' | 'agy' | 'codex' | 'shell',
        ...(flags.persona ? { persona: flags.persona } : {}),
        ...(flags.args ? { args: parseSharedArgs(flags.args) } : {}),
        ...(flags.cwd ? { cwd: flags.cwd } : {}),
        ...(flags['no-resume'] ? { resume: false } : {}),
      });
      return { text: `terminal ${result.name} criado`, json: result };
    }
    case 'remove': {
      const name = required(args[0], 'o nome do nó');
      await call(client, 'regent.remove', { name });
      return { text: `${name} removido`, json: { name } };
    }
    case 'link':
    case 'unlink': {
      const a = required(args[0], 'o primeiro nó');
      const b = required(args[1], 'o segundo nó');
      await call(client, command === 'link' ? 'regent.link' : 'regent.unlink', { a, b });
      return { text: `${a} e ${b} ${command === 'link' ? 'conectados' : 'desconectados'}`, json: { a, b } };
    }
    case 'brief': {
      const target = required(args[0], 'o terminal');
      const persona = required(args[1], 'a função');
      await call(client, 'regent.brief', { target, persona });
      return { text: `função ${persona} entregue a ${target}`, json: { target, persona } };
    }
    case 'persona':
      return executePersona(args, flags, client, io);
    default:
      throw new OrqError('USAGE', `Comando desconhecido: ${command ?? '(nenhum)'}.\n${HELP}`);
  }
}

async function executePersona(args: string[], flags: Flags, client: ClientOptions, io: Io): Promise<Output> {
  const [sub, name, text] = args;
  const isGlobal = Boolean(flags.global);
  const scopeLabel = (scope: 'project' | 'global') => (scope === 'project' ? 'projeto' : 'global');
  switch (sub) {
    case 'list': {
      const result = await call(client, 'persona.list', {});
      const lines = result.personas.map((persona) => `${persona.name}\t${scopeLabel(persona.scope)}`);
      return { text: lines.length > 0 ? lines.join('\n') : 'Nenhuma função.', json: result };
    }
    case 'show': {
      const personaName = required(name, 'o nome da função');
      const result = await call(client, 'persona.show', { name: personaName });
      return { text: result.text, json: result };
    }
    case 'write': {
      const personaName = required(name, 'o nome da função');
      const content = await readText(text, flags.file, io.stdin);
      const result = await call(client, 'persona.write', { name: personaName, text: content, global: isGlobal });
      return {
        text: `função ${result.name} ${result.created ? 'criada' : 'atualizada'} (${scopeLabel(result.scope)})`,
        json: result,
      };
    }
    case 'remove': {
      const personaName = required(name, 'o nome da função');
      await call(client, 'persona.remove', { name: personaName, global: isGlobal });
      return { text: `função ${personaName} removida`, json: { name: personaName, global: isGlobal } };
    }
    default:
      throw new OrqError('USAGE', `Subcomando de persona desconhecido: ${sub ?? '(nenhum)'}. Use list, show, write ou remove.`);
  }
}

async function executeNote(args: string[], flags: { file?: string }, client: ClientOptions, io: Io): Promise<Output> {
  const [sub, name, content] = args;
  switch (sub) {
    case 'list': {
      const result = await call(client, 'note.list', {});
      const lines = result.notes.map((note) => `${note.name} (rev ${note.revision})`);
      return { text: lines.length > 0 ? lines.join('\n') : 'Nenhuma nota conectada a você.', json: result };
    }
    case 'show': {
      const result = await call(client, 'note.show', { name: required(name, 'o nome da nota') });
      return { text: result.content, json: result };
    }
    case 'write': {
      const result = await call(client, 'note.write', { name: required(name, 'o nome da nota'), content: await readText(content, flags.file, io.stdin) });
      return { text: `nota ${result.name} ${result.created ? 'criada' : 'atualizada'} (rev ${result.revision})`, json: result };
    }
    case 'append': {
      const result = await call(client, 'note.append', { name: required(name, 'o nome da nota'), content: await readText(content, flags.file, io.stdin) });
      return { text: `nota ${result.name} atualizada (rev ${result.revision})`, json: result };
    }
    default:
      throw new OrqError('USAGE', `Subcomando de nota desconhecido: ${sub ?? '(nenhum)'}. Use list, show, write ou append.`);
  }
}

function clientFromEnv(env: Io['env']): ClientOptions {
  const pipePath = env.ORQ_PIPE;
  const token = env.ORQ_TOKEN;
  if (!pipePath || !token) {
    throw new OrqError('APP_UNAVAILABLE', 'O orq precisa rodar dentro de um terminal do Orquestra (ORQ_PIPE e ORQ_TOKEN ausentes).');
  }
  return { pipePath, token };
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new OrqError('USAGE', `Falta ${what}.\n${HELP}`);
  return value;
}

async function readText(arg: string | undefined, file: string | undefined, stdin: NodeJS.ReadableStream): Promise<string> {
  if (file) return readFile(file, 'utf8');
  if (arg === '-') return readAll(stdin);
  if (arg) return arg;
  throw new OrqError('USAGE', 'Falta o texto: passe como argumento, use - para ler do stdin ou --file <arquivo>.');
}

async function readAll(stream: NodeJS.ReadableStream, timeoutMs?: number): Promise<string> {
  const chunks: Buffer[] = [];
  const reading = (async () => {
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  })();
  if (timeoutMs === undefined) await reading;
  else await Promise.race([reading, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  return Buffer.concat(chunks).toString('utf8');
}

// Chamado pelos hooks dos agentes: nunca falha e nunca bloqueia o agente.
async function runHook(args: string[], io: Io): Promise<number> {
  const [agent, event] = args;
  // O agy espera JSON válido no stdout do hook.
  if (agent === 'agy') io.stdout.write('{}');
  const raw = agent === 'codex' && args[2] ? args[2] : await readAll(io.stdin, HOOK_STDIN_TIMEOUT_MS);
  const pipePath = io.env.ORQ_PIPE;
  const token = io.env.ORQ_TOKEN;
  // Sem ORQ_*: é uma sessão de fora do Orquestra (o hook do agy é global).
  if (!agent || !event || !pipePath || !token) return 0;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { unparsed: raw };
  }
  try {
    await Promise.race([
      call({ pipePath, token }, 'hook', { agent, event, payload }),
      new Promise((resolve) => setTimeout(resolve, HOOK_CALL_TIMEOUT_MS).unref()),
    ]);
  } catch {
    // O app pode estar fechado ou a sessão já ter sido removida.
  }
  return 0;
}
