# Orquestra

[English](README.md) | Português

O Orquestra é um aplicativo de desktop para Windows que reúne agentes de código com IA e terminais de shell em um único canvas visual, onde eles conversam entre si.

## Por que existe

Rodar vários agentes ao mesmo tempo significa alternar entre janelas de terminal, copiar prompts de uma para outra e perder o controle de quem está trabalhando. O Orquestra coloca todos os agentes em um só canvas. Você desenha conexões entre eles, e um agente conectado pode enviar prompts a outro, ler a tela dele e compartilhar notas. Um agente pode atuar como "regente" e criar e dirigir os demais pela linha de comando `orq`.

## Recursos

- **Terminais de agentes.** Execute os agentes de CLI `claude`, `agy` e `codex`, ou um shell PowerShell, como nós no canvas.
- **Conexões.** Ligue terminais e notas. Terminais ligados podem enviar prompts e ler uns aos outros. Remova uma ligação selecionando-a e apertando Delete, pelo menu de contexto ou pelo botão × na linha.
- **Regente.** Marque um terminal como regente. Ele recebe um guia e pode criar, ligar, remover e instruir outros terminais com `orq`.
- **Funções (personas).** Salve instruções reutilizáveis por projeto ou globalmente e entregue uma a qualquer terminal.
- **Notas.** Notas em Markdown no canvas que os agentes conectados podem ler e escrever.
- **Grupos.** Agrupe terminais, notas e nós de fluxo em uma moldura e mova todos juntos.
- **Workspaces.** Mantenha até três projetos abertos ao mesmo tempo, cada um com seu canvas.
- **Portais de navegador.** Conecte um navegador a um agente para ele navegar, clicar, digitar, rolar a página e capturar telas.
- **Monitoramento de atividade.** Ative o monitoramento por terminal para receber uma notificação do Windows quando ele terminar um turno ou esperar por você com o app fora de foco.
- **Uso das assinaturas.** Veja as janelas de uso e os horários de renovação do Claude, do Codex e do agy.
- **Fluxo visual de dados.** Monte um grafo de processamento no mesmo canvas com nós de entrada, arquivo, algoritmo (JavaScript ou Python), validação, teste, visualização e saída. Veja [docs/fluxo-visual.md](docs/fluxo-visual.md).

## Requisitos

- Windows x64. O código usa pipes nomeados do Windows, `where.exe`, `cmd.exe` e PowerShell, e o instalador é apenas para Windows.
- Node.js 22 ou mais recente e npm, para compilar ou desenvolver a partir do código.
- Os CLIs de agente que você quer usar, instalados e autenticados: `claude`, `agy`, `codex`. O Orquestra os procura no `PATH` e nas pastas comuns de instalação do npm.
- Python 3, opcional, para algoritmos em Python no fluxo visual.

## Instalação

**Pelo instalador.** Gere-o com os passos abaixo e execute `packages/app/release/Orquestra-Setup-<versão>.exe`. O instalador NSIS permite escolher a pasta de instalação e cria atalhos na área de trabalho e no menu Iniciar.

**Pelo código.**

```
npm install
npm run dist
```

O `npm run dist` compila o CLI e o processo host e empacota o app com o electron-builder. O instalador fica em `packages/app/release`.

## Desenvolvimento

```
npm install
npm run dev          # compila o CLI e o host e inicia o app em modo de desenvolvimento
npm test             # testes unitários (vitest)
npm run typecheck    # tsc na raiz e em packages/app
npm run e2e          # testes ponta a ponta do app Electron com Playwright
```

Outros scripts: `npm run build:cli`, `npm run build:host`, `npm run e2e:packaged` (testa o app empacotado) e `npm run harness` (cria terminais reais e os conecta sem a interface).

## O CLI `orq`

O Orquestra injeta `ORQ_PIPE` e `ORQ_TOKEN` em cada terminal que inicia e coloca o `orq` no `PATH` dele. O comando só funciona dentro de um terminal do Orquestra. Adicione `--json` a qualquer comando para obter saída legível por máquina. A ajuda e as mensagens estão em português.

```
orq whoami                              # seu nome e tipo de agente
orq peers                               # terminais (e navegadores) conectados a você
orq prompt revisor "Revise src/app.ts" --timeout 8m
echo "texto longo da tarefa" | orq prompt revisor -
orq read revisor --lines 40             # tela atual de um terminal conectado
orq result <id>                         # resposta de um prompt pendente
orq note write plano "Passo 1: ..."     # também: note list | show | append
orq portal list                         # navegadores conectados a você
orq portal navigate <id> https://example.com
```

Comandos do regente:

```
orq new testador --agent codex --persona qa --cwd ./app   # também: --args "<texto>" --no-resume
orq link testador revisor
orq unlink testador revisor
orq brief testador qa                                     # entrega uma função a um terminal
orq persona write qa "Você é uma pessoa de QA..." --global
orq persona list | show <função> | remove <função> [--global]
orq remove testador
```

O `orq mcp` executa um servidor MCP por stdio que expõe as mesmas operações como ferramentas (`whoami`, `peers`, `prompt`, `read`, `note_*`, `portal_*`, `regent_*`, `persona_*`). O Orquestra o registra automaticamente nos terminais Codex.

## Arquitetura

Workspaces do npm em `packages/`:

| Pacote | Papel |
| --- | --- |
| `app` | App Electron: processo principal, renderer em React (canvas com React Flow, terminais xterm.js), configuração do electron-builder e testes Playwright. |
| `host` | Processo em segundo plano que mantém terminais, workspaces, grupos do canvas e o motor do fluxo visual. O app fala com ele por um protocolo tipado. |
| `core` | Sessões de terminal (node-pty), adaptadores dos agentes claude, agy, codex e shell, servidor de pipe local, notas, funções e uso das assinaturas. |
| `cli` | O comando `orq` e o servidor MCP, empacotados em um único `orq.mjs`. |
| `shared` | Schemas Zod e tipos compartilhados por todos os pacotes: protocolo do host, workspace, fluxo e cliente do CLI. |

## Licença

[MIT](LICENSE)
