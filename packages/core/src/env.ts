// Marcas da sessão que lançou o Orquestra. Herdadas, mudam o comportamento do agente filho
// (o Claude filho desliga a transcrição). Lista explícita: configurações CLAUDE_CODE_* do usuário passam.
const INHERITED_SESSION_ENV = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
]);

export function childEnv(base: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !INHERITED_SESSION_ENV.has(entry[0]),
    ),
  );
}

export function prependPath(env: Record<string, string>, dir: string): Record<string, string> {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key];
  return { ...env, [key]: current ? `${dir};${current}` : dir };
}
