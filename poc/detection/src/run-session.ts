import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPipePath, startEventServer } from './event-server.js';
import { newLinesSince, SilenceDetector } from './heuristic.js';
import { injectPrompt } from './inject.js';
import { spawnPty, type PtySession } from './pty-session.js';
import { resolveExecutable } from './resolve-exe.js';
import { evaluate, type Scenario } from './scenarios.js';
import { Screen } from './screen.js';
import type { AgentDriver, AutoAnswer, HookEnvelope } from './types.js';

export type RunOptions = {
  driver: AgentDriver;
  scenarios: Scenario[];
  runDir: string;
  attach: boolean;
  readyQuietMs?: number;
  heuristicQuietMs?: number;
  turnTimeoutMs?: number;
  autoAnswers?: AutoAnswer[];
};

export type RunResult = {
  scenarioId: string;
  correct: boolean;
  clean: boolean;
  source: 'hook' | 'transcript' | 'none';
  answer: string | null;
  heuristicAnswer: string | null;
  heuristicCorrect: boolean;
  durationMs: number;
  heuristicDeltaMs: number | null;
  waitingUserEvents: number;
};

type HookOutcome = { answer: string | null; source: RunResult['source'] };

type PendingTurn = {
  resolveHook: (outcome: HookOutcome) => void;
  waitingUserEvents: number;
};

const COLS = 120;
const ROWS = 40;
const ABORT_KEY = '\x1d'; // Ctrl+]
const AUTO_ANSWER_SETTLE_MS = 1500;
const AUTO_ANSWER_KEY_GAP_MS = 300;
const PTY_EXIT_TIMEOUT_MS = 3000;

// Resultados ficam no repositório (ignorados pelo git); a pasta de trabalho do agente fica no %TEMP%, longe deles:
// com permissões aprovadas, um agente chegou a ler o results.jsonl de outra rodada e copiar a resposta.
// A pasta de trabalho também não pode estar dentro de um repositório git (o agy sobe até a raiz procurando hooks)
// nem ter espaço no caminho (o agy não respeita aspas no comando do hook).
export const RUNS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '.runs');
export const WORK_ROOT = join(tmpdir(), 'orq-poc-work');

// Marcas da sessão que lançou o runner (Claude Code). Herdadas, mudam o comportamento do agente filho.
// Lista explícita: variáveis CLAUDE_CODE_* de configuração do usuário (ex.: GIT_BASH_PATH) precisam passar.
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

export async function runSession(opts: RunOptions): Promise<RunResult[]> {
  const readyQuietMs = opts.readyQuietMs ?? 4000;
  const heuristicQuietMs = opts.heuristicQuietMs ?? 3000;
  const turnTimeoutMs = opts.turnTimeoutMs ?? 10 * 60_000;
  const sessionDir = join(WORK_ROOT, basename(opts.runDir));
  const workDir = join(sessionDir, 'work');
  const envelopesDir = join(opts.runDir, 'envelopes');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(envelopesDir, { recursive: true });

  const token = randomBytes(32).toString('hex');
  const server = await startEventServer({ pipePath: newPipePath(), token });
  const screen = new Screen(COLS, ROWS);
  let pending: PendingTurn | undefined;
  let envelopeCount = 0;

  server.onRejected((reason) => appendFileSync(join(opts.runDir, 'rejected.log'), `${reason}\n`));
  server.onEnvelope((envelope: HookEnvelope) => {
    envelopeCount++;
    writeFileSync(join(envelopesDir, `${envelopeCount}-${envelope.event}.json`), JSON.stringify(envelope, null, 2));
    const signal = opts.driver.interpret(envelope);
    if (signal.kind === 'waiting-user' && pending) pending.waitingUserEvents++;
    if (signal.kind !== 'turn-end' || !pending) return;
    const turn = pending;
    pending = undefined;
    if (signal.text !== null) return turn.resolveHook({ answer: signal.text, source: 'hook' });
    if (signal.transcriptPath && opts.driver.readTranscript) {
      void opts.driver
        .readTranscript(signal.transcriptPath)
        .then((answer) => turn.resolveHook({ answer, source: answer === null ? 'none' : 'transcript' }));
      return;
    }
    turn.resolveHook({ answer: null, source: 'none' });
  });

  const launch = opts.driver.launch({ workDir, sessionDir });
  const executable = resolveExecutable(launch.name);
  const pty = spawnPty({
    file: executable.file,
    args: [...executable.argsPrefix, ...launch.args],
    cwd: workDir,
    env: { ...childEnv(process.env), ...launch.env, ORQ_POC_PIPE: server.pipePath, ORQ_POC_TOKEN: token },
    cols: COLS,
    rows: ROWS,
  });

  let lastOutputAt = Date.now();
  let exited = false;
  const heuristic: { firedAt: number | null } = { firedAt: null };
  const detector = new SilenceDetector({ quietMs: heuristicQuietMs, onQuiet: () => (heuristic.firedAt = Date.now()) });

  const visibleText = () => screen.text().split('\n').slice(-ROWS).join('\n');
  const answering = (opts.autoAnswers ?? opts.driver.autoAnswers ?? []).map((rule) => ({ rule, showing: false }));
  let answersInFlight = 0;
  const answer = async (rule: AutoAnswer) => {
    answersInFlight++;
    try {
      await sleep(AUTO_ANSWER_SETTLE_MS);
      if (!rule.whenScreen.test(visibleText())) return;
      appendFileSync(join(opts.runDir, 'auto-answers.log'), `${new Date().toISOString()} ${rule.whenScreen}\n`);
      for (const keys of rule.keys) {
        pty.write(keys);
        await sleep(AUTO_ANSWER_KEY_GAP_MS);
      }
      lastOutputAt = Date.now();
    } finally {
      answersInFlight--;
    }
  };
  let currentScenario: Scenario | undefined;
  const checkAutoAnswers = () => {
    const visible = visibleText();
    for (const entry of answering) {
      const applies = entry.rule.onlyWhen?.(currentScenario) ?? true;
      const matches = applies && entry.rule.whenScreen.test(visible);
      if (matches && !entry.showing) void answer(entry.rule);
      entry.showing = matches;
    }
  };

  pty.onData((data) => {
    lastOutputAt = Date.now();
    appendFileSync(join(opts.runDir, 'pty.log'), data);
    void screen.write(data).then(checkAutoAnswers);
    detector.feed();
    if (opts.attach) process.stdout.write(data);
  });
  const ptyExited = new Promise<void>((resolve) =>
    pty.onExit(() => {
      exited = true;
      resolve();
    }),
  );
  const exitOutcome = ptyExited.then((): HookOutcome => ({ answer: null, source: 'none' }));

  if (opts.attach) attachKeyboard((data) => pty.write(data), () => pty.kill());

  await waitUntil(() => (answersInFlight === 0 && Date.now() - lastOutputAt >= readyQuietMs) || exited, 100);

  const results: RunResult[] = [];
  for (const scenario of opts.scenarios) {
    if (exited) break;
    currentScenario = scenario;
    scenario.setup?.(workDir);
    const before = screen.text();
    const startedAt = Date.now();
    heuristic.firedAt = null;

    const turn: PendingTurn = { resolveHook: () => {}, waitingUserEvents: 0 };
    const hookResult = new Promise<HookOutcome>((resolve) => (turn.resolveHook = resolve));
    pending = turn;
    detector.arm();
    await injectPrompt(pty, scenario.prompt, opts.driver.pasteMode);

    const outcome = await Promise.race([
      hookResult,
      exitOutcome,
      sleep(turnTimeoutMs).then((): HookOutcome => ({ answer: null, source: 'none' })),
    ]);
    if (pending === turn) {
      // Prazo esgotado e o agente segue ocupado: como o broker da spec, só injetamos o próximo prompt
      // com o agente ocioso. O Stop atrasado é consumido aqui para não ser atribuído ao próximo cenário.
      await Promise.race([
        new Promise<void>((resolve) => (turn.resolveHook = () => resolve())),
        ptyExited,
        sleep(turnTimeoutMs),
      ]);
      pending = undefined;
    }

    await waitUntil(() => heuristic.firedAt !== null, 100, heuristicQuietMs * 3);
    detector.disarm();
    const heuristicAnswer = heuristic.firedAt === null ? null : newLinesSince(before, screen.text(), scenario.prompt);
    const { correct, clean } = evaluate(scenario, outcome.answer);

    const result: RunResult = {
      scenarioId: scenario.id,
      correct,
      clean,
      source: outcome.source,
      answer: outcome.answer,
      heuristicAnswer,
      heuristicCorrect: evaluate(scenario, heuristicAnswer).correct,
      durationMs: Date.now() - startedAt,
      heuristicDeltaMs: heuristic.firedAt === null ? null : heuristic.firedAt - startedAt,
      waitingUserEvents: turn.waitingUserEvents,
    };
    results.push(result);
    appendFileSync(join(opts.runDir, 'results.jsonl'), JSON.stringify(result) + '\n');
  }

  await killAndWait(pty, () => exited);
  if (opts.attach) detachKeyboard();
  await server.close();
  return results;
}

// Sair do processo com o ConPTY ainda fechando trava o process.exit no Windows: esperamos o fim do PTY.
async function killAndWait(pty: PtySession, hasExited: () => boolean): Promise<void> {
  if (hasExited()) return;
  const done = new Promise<void>((resolve) => pty.onExit(() => resolve()));
  pty.kill();
  await Promise.race([done, sleep(PTY_EXIT_TIMEOUT_MS)]);
}

function attachKeyboard(write: (data: string) => void, abort: () => void): void {
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.on('data', (data: string) => (data === ABORT_KEY ? abort() : write(data)));
}

function detachKeyboard(): void {
  process.stdin.setRawMode?.(false);
  process.stdin.removeAllListeners('data');
  process.stdin.pause();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, intervalMs: number, maxMs = Number.POSITIVE_INFINITY): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!condition() && Date.now() < deadline) await sleep(intervalMs);
}
