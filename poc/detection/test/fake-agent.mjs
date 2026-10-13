// Agente falso para testes: imprime um prompt, lê uma colagem entre colchetes + Enter,
// responde e chama o relay como um hook Stop faria.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const relay = process.env.FAKE_RELAY_PATH;
const answers = { 'Quanto é 17 × 23? Responda só com o número.': '391' };
let buffer = '';
let turns = 0;

function emitStop(answer) {
  spawnSync(process.execPath, [relay, 'fake', 'Stop'], {
    input: JSON.stringify({ last_assistant_message: answer, session_id: 'fake-1' }),
    env: process.env,
  });
}

process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
// Simula o diálogo de confiança na pasta: só fica pronto depois de receber "s".
let trusted = process.env.FAKE_ASK_TRUST !== '1';

function greet() {
  process.stdout.write('\x1b[?2004h\x1b[32mfake pronto\x1b[0m\r\n> ');
  // Simula um Stop atrasado que chega sem prompt em curso.
  if (process.env.FAKE_STRAY_STOP === '1') emitStop('fantasma');
}

if (trusted) greet();
else process.stdout.write('Confiar nesta pasta? (s/n) ');

process.stdin.on('data', (chunk) => {
  if (process.env.FAKE_INPUT_LOG) appendFileSync(process.env.FAKE_INPUT_LOG, JSON.stringify(chunk) + '\n');
  if (!trusted) {
    if (chunk === 's') {
      trusted = true;
      process.stdout.write('\x1b[2J\x1b[H');
      greet();
    }
    return;
  }
  if (permissionFor !== null) {
    // Diálogo de permissão aberto: "s" aprova, ESC nega; qualquer outra tecla é ignorada.
    if (chunk !== 's' && chunk !== '\x1b') return;
    const prompt = permissionFor;
    permissionFor = null;
    finishTurn(prompt, chunk === 's' ? 'permitido' : 'negado');
    return;
  }
  buffer += chunk;
  processNext();
});

// Simula um agente que pede permissão antes de cada resposta (FAKE_ASK_PERMISSION=1).
let permissionFor = null;

function finishTurn(prompt, answer) {
  process.stdout.write(`\x1b[2J\x1b[H${prompt}\r\n\r\n\x1b[1m${answer}\x1b[0m\r\n\r\n> `);
  emitStop(answer);
  busy = false;
  processNext();
}

// Como um agente real, atende um prompt por vez: o que chega durante um turno espera na fila.
let busy = false;
function processNext() {
  if (busy) return;
  // O modo raw do Node no Windows entrega a colagem sem os marcadores; aceitamos as duas formas.
  const match = buffer.match(/(?:\x1b\[200~)?([\s\S]*?)(?:\x1b\[201~)?\r/);
  if (!match) return;
  buffer = buffer.slice(match.index + match[0].length);
  if (process.env.FAKE_EXIT_ON_PROMPT === '1') process.exit(3);
  const prompt = match[1];
  const answer = answers[prompt] ?? `eco: ${prompt}`;
  // Simula um turno longo: só o primeiro prompt demora FAKE_FIRST_DELAY_MS.
  const delay = turns++ === 0 ? Number(process.env.FAKE_FIRST_DELAY_MS ?? 0) : 0;
  busy = true;
  if (process.env.FAKE_ASK_PERMISSION === '1') {
    permissionFor = prompt;
    process.stdout.write(`${prompt}\r\nPermitir este comando? (s/ESC) `);
    return;
  }
  setTimeout(() => finishTurn(prompt, answer), delay);
}
