// Agente falso: lê um prompt até o Enter, responde "eco: <prompt>" e chama o hook Stop pelo orq real.
import { execSync } from 'node:child_process';

const hookCommand = process.env.FAKE_HOOK_CMD;
const firstDelayMs = Number(process.env.FAKE_FIRST_DELAY_MS ?? 0);
let buffer = '';
let busy = false;
let turns = 0;

process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
process.stdout.write('fake pronto\r\n> ');

function stop(answer) {
  execSync(hookCommand, { input: JSON.stringify({ last_assistant_message: answer }), stdio: ['pipe', 'ignore', 'ignore'] });
}

function next() {
  if (busy) return;
  const end = buffer.indexOf('\r');
  if (end < 0) return;
  const prompt = buffer.slice(0, end).replace(/\x1b\[20[01]~/g, '');
  buffer = buffer.slice(end + 1);
  busy = true;
  const delay = turns++ === 0 ? firstDelayMs : 0;
  setTimeout(() => {
    const shown = prompt.replace(/\n/g, '\r\n');
    if (prompt.includes('INTERROMPA')) {
      process.stdout.write(`${shown}\r\nInterrupted · What should Fake do instead?\r\n> `);
    } else {
      const answer = `eco: ${prompt.replace(/\n/g, ' | ')}`;
      process.stdout.write(`${shown}\r\n${answer}\r\n> `);
      stop(answer);
    }
    busy = false;
    next();
  }, delay);
}

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  next();
});
