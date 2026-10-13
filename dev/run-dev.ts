import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { devEnv } from './dev-env.js';

const env = devEnv(process.env, userInfo().username);

const child = spawn('npm', ['run', 'dev', '-w', '@orquestra/app'], {
  env,
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
