import { run } from './run.js';

const code = await run(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});
// Espera o stdout esvaziar antes de sair: respostas grandes seriam cortadas pelo process.exit.
await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
process.exit(code);
