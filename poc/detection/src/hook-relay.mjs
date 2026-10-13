// Chamado pelos hooks dos agentes. Nunca bloqueia o agente: sai com 0 em qualquer caso.
import net from 'node:net';

const [agent, event] = process.argv.slice(2);
// O agy espera JSON válido no stdout do hook; os demais não precisam de saída.
if (agent === 'agy') process.stdout.write('{}');
const pipePath = process.env.ORQ_POC_PIPE;
const token = process.env.ORQ_POC_TOKEN;

setTimeout(() => process.exit(0), 5000);
if (!pipePath || !token) process.exit(0);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { unparsed: raw };
  }
  const socket = net.connect(pipePath, () => {
    socket.end(JSON.stringify({ token, agent, event, payload }) + '\n');
  });
  socket.on('close', () => process.exit(0));
  socket.on('error', () => process.exit(0));
});
