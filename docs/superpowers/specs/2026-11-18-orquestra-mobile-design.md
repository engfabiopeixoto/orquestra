# Orquestra no celular: desenho

## Intenção

O Orquestra continua instalado e rodando no PC. O celular é só um controle remoto dos workspaces desse PC. Pelo celular, o usuário:
- acompanha os agentes;
- responde quando um agente está esperando;
- manda mensagens;
- reinicia, descarrega ou recarrega terminais.

O acesso é pelo Tailscale, que o usuário já tem no celular: o PC não abre nenhuma porta pública.

Base: `docs/pesquisa/orquestra-android-viabilidade.md` e `docs/pesquisa/android-arquitetura.md`.

## Decisões

| Tema | Decisão | Por quê |
|---|---|---|
| Cliente | **PWA** (React 19 + Vite + TypeScript), servida pelo próprio Orquestra e instalável na tela inicial do Android | Uma base só, sem loja nem APK. Reaproveita os schemas de `shared` e o xterm.js. O Capacitor fica para depois, se faltar push com o app fechado. |
| Rede | O gateway escuta **só em `127.0.0.1:47820`**. O Orquestra o expõe à tailnet com `tailscale serve --bg --https=8443 http://127.0.0.1:47820`, o que dá HTTPS com certificado válido em `https://<máquina>.<tailnet>.ts.net:8443` | O HTTPS é exigido para PWA, service worker e notificações. Não há porta pública nem certificado próprio. A porta 8443 não colide com outros serves do usuário. |
| Plano B de rede | Se o `tailscale serve` falhar (por exemplo, HTTPS desligado na tailnet), o painel mostra o erro e oferece ouvir em `http://<IP 100.x do Tailscale>:47820` | O tráfego continua cifrado pelo WireGuard. Sem HTTPS só perde a instalação como app e as notificações. |
| Onde roda o gateway | Dentro do processo do host, ao lado do workspace-manager (`packages/host/src/remote/`) | O gateway é um segundo cliente do mesmo `bridge.handle`: reaproveita comandos, validação e eventos sem duplicar regras. |
| Transporte | HTTP para os arquivos estáticos e o pareamento; WebSocket (pacote `ws`) para comandos e eventos | Eventos em tempo real e uma conexão só. |
| Identidade | Pareamento por QR com link de uso único (32 bytes aleatórios, vale 5 min). O link é trocado por um **token de dispositivo** (32 bytes), guardado no celular. No PC fica só o hash SHA-256, em `<dataDir>/remote-devices.json`, com nome, data e último acesso | Defesa em profundidade além da tailnet. Cada dispositivo pode ser revogado. Nunca reaproveita `ORQ_TOKEN`. |
| Autorização | Lista explícita de métodos permitidos ao celular (abaixo). Todo o resto é recusado | O host executa processos com a conta do PC. O celular não lê arquivos, não edita configurações e não roda fluxos. |
| Ligado por padrão? | **Não.** Liga em "Padrões dos agentes" → seção **Celular**: interruptor, endereço, QR de pareamento, lista de dispositivos com "Revogar" e estado do Tailscale | Superfície remota só quando o usuário pede. |
| Workspace selecionado | É o mesmo do PC. Ativar pelo celular troca também no PC | O host só transmite a saída do workspace ativo. Separar a seleção fica para depois. |

### Métodos permitidos ao celular

- **Leitura:** `workspace.list`, `workspace.activate`, `terminal.snapshot`, `models.catalog`, `usage.claude`, `usage.codex`, `usage.agy`.
- **Interação:** `terminal.input`, `terminal.send` (novo), `prompt.cancel`.
- **Administração, com confirmação no celular:** `terminal.restart`, `terminal.unload`, `terminal.model`.
- **Eventos:** todos os de estado, fila, turno, modelo e avisos. `terminal.output` vai só para os terminais que o cliente assinou. A parte `confirm` e o portal ficam só no PC.

`terminal.send` é um comando novo: `{ name, text }`. Ele cola o texto como o usuário colaria no desktop (bracketed paste quando houver várias linhas) e envia Enter. Assim, mandar uma mensagem do celular é o mesmo que digitá-la no PC.

## Segurança (obrigatório)

- Gateway desligado por padrão e sempre em 127.0.0.1. Com o plano B, ouve no IP do Tailscale, nunca em `0.0.0.0`.
- Token só no cabeçalho `Authorization: Bearer` (HTTP) e na primeira mensagem do WebSocket (`{type:'auth', token}`). Fechar a conexão se não autenticar em 5 s.
- `Origin` conferida no WebSocket.
- Comparação em tempo constante. Pareamento limitado a 5 tentativas por minuto.
- Mensagem de no máximo 64 KB. Parâmetros validados pelos schemas do host-protocol antes de repassar.
- Log de auditoria (`dispositivo`, `método`, `terminal`) sem o texto digitado.
- Notificações sem conteúdo do terminal: só "dev2-agy está esperando você".

## Fluxo de saída do terminal

- Ao abrir um terminal, o celular manda `{type:'subscribe', workspaceId, name}`, recebe o `terminal.snapshot` e depois o `terminal.output`.
- Por conexão, a saída é agrupada a cada 50 ms. Se o buffer passar de 1 MB, a saída é cortada e o celular é avisado para pedir um snapshot novo.
- Ao reconectar, o celular busca a lista e o snapshot de novo. Não há replay de eventos.

## Telas do celular (pt-BR, tema escuro, uma mão, alvos de toque de 44 px ou mais)

1. **Parear:** abre pelo link do QR. Pede o nome do dispositivo e guarda o token.
2. **Workspaces:** cartões com nome, agentes ocupados e agentes "esperando você". Um toque ativa o workspace.
3. **Agentes do workspace:**
   - um cartão por terminal, com nome, agente, modelo, estado colorido (ocioso, ocupado, esperando você, descarregado) e pedidos na fila;
   - os que estão "esperando você" ficam no topo;
   - ao lado, o crédito das assinaturas.
4. **Terminal:**
   - xterm em tela cheia, ajustado à largura do celular, só para leitura de rolagem;
   - embaixo, caixa "Mensagem para <agente>" com botão enviar (`terminal.send`);
   - barra de teclas: Enter, Esc, Tab, ↑, ↓, Ctrl+C e 1, 2, 3 para menus de aprovação;
   - menu ⋮ com Reiniciar, Descarregar/Recarregar e Trocar modelo, sempre com confirmação.
5. **Notificações:** com o app aberto ou em segundo plano recente, o service worker mostra "<agente> está esperando você" ou "<agente> terminou", com vibração. Tocar abre o terminal.
   - **Limitação conhecida:** sem push com o app fechado. O push exigiria FCM, que fica fora do MVP.

## Fases

| Fase | Entrega | Pronto quando |
|---|---|---|
| **1. Gateway e leitura** | `packages/host/src/remote/` (servidor, pareamento, dispositivos, lista de métodos permitidos, roteamento de respostas, eventos); `packages/mobile` (parear, workspaces, agentes); script `npm run mobile:dev`; seção Celular nas configurações (interruptor, QR, dispositivos) | Testes do gateway passam. Pelo portal, em viewport de celular, dá para parear e ver workspaces e agentes ao vivo. |
| **2. Terminal e ações** | Tela do terminal (snapshot e stream), `terminal.send`, barra de teclas, reiniciar, descarregar/recarregar e trocar modelo com confirmação, controle de fluxo da saída | Pelo portal, dá para abrir um terminal, ver a saída ao vivo, mandar mensagem e ver o agente responder. |
| **3. App e rede** | Manifest e service worker (instalável), notificações, integração com o `tailscale serve` e o plano B, mobile no instalador (extraResources), README | `npm run dist` gera o instalador com o mobile. As configurações mostram a URL do Tailscale e o QR. |

### `npm run mobile:dev`

Sobe um host de teste, no padrão de `dev/harness.ts`, com pasta de dados temporária, pipe próprio, agentes shell e falsos e o gateway em `127.0.0.1:47821`. Também serve o build do mobile e imprime um link de pareamento já válido. É assim que o portal testa sem tocar no Orquestra instalado.

## Fora do escopo

- Push com o app fechado (FCM).
- Executar agentes no celular.
- Explorador de arquivos e fluxos no celular.
- Seleção de workspace independente do PC.
- Mais de um usuário.
