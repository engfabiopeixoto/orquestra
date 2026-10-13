# Orquestra

English | [Português](README.pt-BR.md)

Orquestra is a Windows desktop app that puts AI coding agents and shell terminals on one visual canvas, where they can talk to each other.

## Why it exists

Running several agents at once means juggling terminal windows, copying prompts between them and losing track of who is working. Orquestra puts every agent on one canvas. You draw connections between them, and a connected agent can prompt another, read its screen and share notes. One agent can act as a "regent" that creates and directs the others through the `orq` command line.

## Features

- **Agent terminals.** Run `claude`, `agy` and `codex` CLI agents, or a PowerShell shell, as nodes on the canvas.
- **Connections.** Link terminals and notes. Linked terminals can prompt and read each other. Remove a link by selecting it and pressing Delete, from its context menu, or with the × button on the line.
- **Regent.** Mark a terminal as regent. It receives a guide and can create, link, remove and brief other terminals with `orq`.
- **Roles (personas).** Save reusable instructions per project or globally, and hand one to any terminal.
- **Notes.** Markdown notes on the canvas that connected agents can read and write.
- **Groups.** Frame related terminals, notes and flow nodes, and move them together.
- **Workspaces.** Keep up to three projects open at once, each with its own canvas.
- **Browser portals.** Connect a browser node to an agent so it can navigate, click, type, scroll and take screenshots.
- **Activity monitoring.** Turn on monitoring per terminal to get a Windows notification when it finishes a turn or waits for you while the app is unfocused.
- **Subscription usage.** See the usage windows and reset times for Claude, Codex and agy.
- **Visual data flow.** Build a processing graph on the same canvas with input, file, algorithm (JavaScript or Python), validation, test, view and output nodes. See [docs/fluxo-visual.md](docs/fluxo-visual.md) (in Portuguese).

## Requirements

- Windows x64. The code relies on Windows named pipes, `where.exe`, `cmd.exe` and PowerShell, and the installer targets Windows only.
- Node.js 22 or newer and npm, to build or develop from source.
- The agent CLIs you want to use, installed and signed in: `claude`, `agy`, `codex`. Orquestra finds them on `PATH` and in the common npm install folders.
- Python 3, optional, for Python algorithms in the visual flow.

## Install

**From the installer.** Build it with the steps below, then run `packages/app/release/Orquestra-Setup-<version>.exe`. The NSIS installer lets you pick the install folder and creates desktop and Start menu shortcuts.

**From source.**

```
npm install
npm run dist
```

`npm run dist` builds the CLI and the host process, then packages the app with electron-builder. The installer lands in `packages/app/release`.

## Development

```
npm install
npm run dev          # builds the CLI and host, then starts the app in dev mode
npm test             # unit tests (vitest)
npm run typecheck    # tsc for the root and for packages/app
npm run e2e          # Playwright end-to-end tests of the Electron app
```

Other scripts: `npm run build:cli`, `npm run build:host`, `npm run e2e:packaged` (tests the packaged app) and `npm run harness` (creates real terminals and connects them without the UI).

## The `orq` CLI

Orquestra injects `ORQ_PIPE` and `ORQ_TOKEN` into every terminal it starts and puts `orq` on its `PATH`. The command only works inside an Orquestra terminal. Add `--json` to any command for machine-readable output. The help and messages are in Portuguese.

```
orq whoami                              # your name and agent type
orq peers                               # terminals (and browsers) connected to you
orq prompt reviewer "Review src/app.ts" --timeout 8m
echo "long task text" | orq prompt reviewer -
orq read reviewer --lines 40            # current screen of a connected terminal
orq result <id>                         # answer of a pending prompt
orq note write plan "Step 1: ..."       # also: note list | show | append
orq portal list                         # browsers connected to you
orq portal navigate <id> https://example.com
```

Regent commands:

```
orq new tester --agent codex --persona qa --cwd ./app   # also: --args "<text>" --no-resume
orq link tester reviewer
orq unlink tester reviewer
orq brief tester qa                                     # hand a role to a terminal
orq persona write qa "You are a QA engineer..." --global
orq persona list | show <role> | remove <role> [--global]
orq remove tester
```

`orq mcp` runs an MCP server over stdio that exposes the same operations as tools (`whoami`, `peers`, `prompt`, `read`, `note_*`, `portal_*`, `regent_*`, `persona_*`). Orquestra registers it automatically for Codex terminals.

## Architecture

npm workspaces under `packages/`:

| Package | Role |
| --- | --- |
| `app` | Electron app: main process, React renderer (canvas with React Flow, xterm.js terminals), electron-builder config and Playwright tests. |
| `host` | Background process that owns terminals, workspaces, canvas groups and the visual flow engine. The app talks to it over a typed protocol. |
| `core` | Terminal sessions (node-pty), agent adapters for claude, agy, codex and shell, the local pipe server, notes, personas and subscription usage. |
| `cli` | The `orq` command and the MCP server, bundled to a single `orq.mjs`. |
| `shared` | Zod schemas and types shared by all packages: host protocol, workspace, flow and CLI client. |

## License

[MIT](LICENSE)
