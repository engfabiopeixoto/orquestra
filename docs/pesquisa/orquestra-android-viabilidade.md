# Viabilidade: controle remoto do Orquestra desktop pelo Android

**Veredito: viável, com esforço médio.** O Orquestra continua instalado e rodando no PC; o celular é apenas um cliente para controlar os workspaces desse PC. Recomendo entregar primeiro uma PWA/web responsiva, acessível por VPN privada, mantendo o host e os agentes no desktop. Capacitor pode empacotar essa mesma interface depois, se push e distribuição Android nativa forem necessários.

Estimativas por fatia são semanas de um desenvolvedor familiarizado com TypeScript/React/Electron, incluindo validação básica, mas não revisão de segurança externa, publicação ou suporte prolongado. A arquitetura atual já tem schemas de workspace/snapshot/eventos e renderer web reutilizáveis ([android-arquitetura.md:18-27,47-65](android-arquitetura.md)).

## O que significa controlar os workspaces

| Capacidade no celular | Fatia / esforço | O que precisa no host |
|---|---|---|
| Listar workspaces e alternar o ativo | **1 · 1–2 semanas** | `workspace.list` e `workspace.activate` já existem ([host-protocol.ts:123-124](../../packages/shared/src/host-protocol.ts)). A API de rede deve retornar lista, seleção e snapshot na ativação, preservando o estado/sequence por workspace. |
| Ver canvas e estado de cada agente: ocioso, ocupado, aguardando você; ver fila | **1 · 2–3 semanas** | Snapshot e eventos já carregam terminais, filas, estado e workspace ([host-protocol.ts:69-87,248-268](../../packages/shared/src/host-protocol.ts)). Adaptar o layout para telefone, incluir modo lista e limitar eventos ao workspace selecionado; implementar stream e reconciliação por sequência. |
| Receber notificação quando agente aguarda | **2 · 1–2 semanas** | Observar mudança para `waiting` no host; emitir aviso sem conteúdo sensível. Para push com app suspenso, registrar dispositivo e integrar FCM/Capacitor; a notificação deve abrir o workspace/terminal. |
| Aprovar ou responder ao agente | **3 · 1–2 semanas** | Reutilizar `terminal.input` ([host-protocol.ts:177](../../packages/shared/src/host-protocol.ts)). A conexão remota precisa conferir workspace/terminal, enviar uma única vez e reportar confirmação de entrega. |
| Mandar prompt a um agente | **3 · 1–2 semanas** | Acrescentar método de host para submissão ao broker (não há `prompt.submit` na lista de métodos atual; há cancelamento em [host-protocol.ts:185](../../packages/shared/src/host-protocol.ts)). Retornar `askId`, estado de fila e resposta/evento; deduplicar reenvio após reconexão. |
| Ativar e pausar workspaces | **4 · 1–2 semanas** | Ativação já existe. O host mantém workspaces pausados quando não ativos ([workspace-manager.ts:31,132-176](../../packages/host/src/workspace-manager.ts)), mas não há comando remoto explícito de pausa: definir semântica, comando e evento/estado, incluindo o que acontece com agentes e pedidos em andamento. |
| Reiniciar um terminal | **4 · 0,5–1 semana** | `terminal.restart` já é método do host; o cliente remoto precisa autorizá-lo, confirmar o terminal e atualizar snapshot/eventos ([host-protocol.ts:169-183](../../packages/shared/src/host-protocol.ts)). |
| Ver saída do terminal, somente leitura primeiro | **1 · 1–2 semanas** | `terminal.output` já é evento ([host-protocol.ts:253](../../packages/shared/src/host-protocol.ts)). Implementar inscrição por terminal/workspace, limites e backpressure; enviar snapshot de tela ao abrir e ao reconectar. Sem entrada remota nesta fatia. |
| Digitar no terminal | **5 · 2–3 semanas** | `terminal.input` já existe. Acrescentar controle de foco/escrita, dimensões, ordem de mensagens e política para concorrência com desktop/outro celular. Validar teclado virtual e barra de teclas especiais em Android real. |

As fatias compartilham a construção inicial do transporte seguro: estimar **3–5 semanas adicionais** para WebSocket/HTTPS, pareamento, autenticação, autorização, reconexão e auditoria mínima. Faixa total indicativa: **12–20 semanas** para o escopo acima; adicionar Capacitor, notificações nativas, publicação e acabamento pode acrescentar **2–5 semanas**. Há sobreposição entre itens da tabela, portanto não some cada linha como prazo independente.

## Como o celular alcança o PC

- **Dentro de casa/escritório:** o celular e o PC podem usar a mesma Wi-Fi, com o host ouvindo numa interface LAN explicitamente habilitada e TLS. É direto e de baixo custo, mas exige descoberta/endereço e configuração de firewall/certificado.
- **Fora de casa:** o PC precisa de canal acessível apesar de NAT/firewall. Alternativas são VPN mesh (por exemplo Tailscale), túnel de saída gerenciado ou relay. A pesquisa compara LAN, Tailscale, Cloudflare Tunnel e relay E2EE ([android-pesquisa.md:85-97](android-pesquisa.md)).
- **Recomendação do MVP:** usar VPN privada (Tailscale ou equivalente) tanto em casa quanto fora. O usuário instala/loga no telefone e PC; o host não abre porta pública. Para primeiro protótipo de mesma rede pode haver LAN, mas não se deve publicar o listener sem TLS, pareamento e autenticação. Adiar relay próprio reduz operação e dados expostos a terceiros.

O pipe local atual é transporte JSON newline para CLI local, não servidor remoto ([pipe-server.ts:18-40,53-80](../../packages/core/src/pipe-server.ts)). Criar um gateway separado HTTP(S)/WebSocket; não expor o pipe nem reaproveitar `ORQ_TOKEN`, que é credencial por terminal herdada pelo subprocesso ([orquestra.ts:202-218](../../packages/core/src/orquestra.ts)). Eventos já carregam sequência e workspace; ainda é necessário cursor/replay por cliente, snapshot após lacuna, limite de buffer e backpressure ([events.ts:7-36](../../packages/app/src/renderer/src/events.ts)).

## Fatias sugeridas

1. **Base remota e observação — 4–6 semanas.** Parear o celular, listar/alternar workspaces, ver canvas e estados, acompanhar saída de terminal em modo somente leitura. Host: gateway de rede, auth inicial, eventos/snapshot e adaptação de layout; proteger output com subscrição, limites e retomada. PWA como primeiro cliente.
2. **Espera e notificações — 2–3 semanas.** Receber e abrir notificação quando o agente aguarda; ver contexto no app. Host: registro/revogação de dispositivo, evento `waiting`, integração push e payload mínimo. Começar com notificação enquanto app aberto; push nativo pode compor o final desta fatia.
3. **Interação por prompts — 2–3 semanas.** Aprovar/responder, enviar prompt e acompanhar/cancelar fila. Host: método de submissão ao broker, deduplicação por id, autorização por workspace e confirmação de entrega.
4. **Administração de workspace/terminal — 1,5–3 semanas.** Ativar/pausar workspace e reiniciar terminal. Host: comando explícito de pausa, semântica para trabalho em andamento, auditoria e evento/snapshot atualizado.
5. **Terminal com entrada — 2–3 semanas.** Digitar após validar leitura. Host: autorização de escrita, resize, ordenação, concorrência e limites. Mobile: xterm em tela dedicada, Ctrl/Esc/Tab/setas/Enter, foco e teclado virtual.

O renderer React/React Flow/Zustand e xterm.js são base reaproveitável, mas `window.orquestra` depende do preload Electron e deve virar uma interface de transporte substituível; o canvas precisa de alternativa compacta para telas estreitas ([android-arquitetura.md:58-65](android-arquitetura.md)).

## Segurança e decisões necessárias

O host controla PTYs executados como a conta do PC e também oferece leitura de arquivos e execução de fluxos; comprometer a API pode dar controle dos projetos e processos do usuário ([android-arquitetura.md:67-75](android-arquitetura.md)). Requisitos mínimos: VPN/TLS; pareamento QR de uso único; credenciais curtas, revogáveis e com escopos (leitura, prompt, terminal, administração); limitação de tentativas e taxa; validação de schemas/tamanho; auditoria; confirmação explícita para reinício/pausa e ações sensíveis; não incluir conteúdo de terminal em push; não armazenar segredos de agentes no telefone. O desktop deve mostrar e permitir revogar dispositivos pareados.

Decisões do produto: PWA primeiro ou APK Capacitor já no MVP; exigir VPN no acesso externo; permitir mais de um celular; política para escrita concorrente; quais comandos administrativos entram no MVP; e se notificações push são indispensáveis quando o app está fechado.

## Alternativas descartadas

- **Agentes rodando no Android:** fora do escopo. A base depende de PTY/ConPTY e CLIs locais; portar execução, processos em segundo plano e filesystem para Termux cria outro produto e alta manutenção ([android-pesquisa.md:17-57](android-pesquisa.md)).
- **Host na nuvem:** fora do escopo. O requisito é controlar os workspaces do PC do usuário, mantendo nele arquivos, credenciais e agentes; nuvem duplicaria ambientes e custos sem atender melhor esse objetivo.

Não incluir integração .NET/Revit nesta iniciativa: não há essa capacidade ou domínio no código levantado; só avaliar uma integração desktop separada quando surgir caso de uso concreto.
