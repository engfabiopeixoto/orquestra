# Pesquisa de Viabilidade: Orquestra Mobile para Android

## Resumo Executivo
1. Rodar os agentes e o runtime completo do Orquestra nativamente no Android é inviável para um produto estável e distribuível.
2. Embora o Termux permita executar Node.js, Git e a CLI do Claude Code em ARM64, há barreiras críticas de compilação do `node-pty` na Bionic libc e ausência de ConPTY.
3. O Android 12+ encerra agressivamente processos secundários via Phantom Process Killer (limite de 32 processos filhos) e Doze Mode, matando agentes em segundo plano.
4. Distribuir um app na Google Play Store que baixe e execute binários ou interpretadores arbitrários viola expressamente a política de "Device and Network Abuse".
5. O caso histórico do Termux comprova esse bloqueio: o Android 10+ impõe restrições de W^X (`execve` proibido em diretórios graváveis do app) e o app estagnou na Play Store.
6. A arquitetura viável e com alto valor agregado é o modelo "Controle Remoto" (Thin Client): o Orquestra continua rodando no PC desktop enquanto o celular se conecta remotamente.
7. Para conexão fora de casa, redes mesh P2P (Tailscale/WireGuard), túneis reversos (Cloudflare Tunnel) ou relays WebSocket criptografados ponta a ponta (E2EE) são as melhores soluções.
8. Notificações push via Firebase Cloud Messaging (FCM) ou Web Push permitem alertar o celular no instante em que um agente entra em estado "aguardando você".
9. O framework Capacitor é a melhor stack: viabiliza reaproveitar mais de 90% do código React existente (Canvas @xyflow/react, componentes e xterm.js), suportando FCM nativo.
10. Apps bem-sucedidos no mercado (como o Happy para Claude Code, Termius, code-server e VS Code Tunnels) adotam exatamente esse paradigma de cliente leve sobre servidor remoto.

---

## 1. Rodar os Agentes no Próprio Android (Termux e Execução Local)

A ideia de transformar o smartphone Android em uma estação de trabalho autônoma que execute o host do Orquestra e os agentes de IA (Claude Code, Antigravity/Gemini CLI, Codex CLI) enfrenta barreiras severas de sistema operacional, arquitetura e hardware.

### 1.1 Instalação e Execução de CLIs via Termux
* **Claude Code (`@anthropic-ai/claude-code`):** É distribuído como um pacote npm em Node.js. No Termux (ambiente Linux sobre Android em arquitetura `aarch64`/ARM64), é possível instalar o Node.js (`pkg install nodejs`) e instalar o pacote globalmente via `npm install -g @anthropic-ai/claude-code`. Relatos da comunidade confirmam execução básica ([Builder.io - Running Claude Code on Android](https://www.builder.io/blog/claude-code-android-termux), [GitHub - ferrumclaudepilgrim/claude-code-android](https://github.com/ferrumclaudepilgrim/claude-code-android)). No entanto, binários compilados nativamente que acompanham certos pacotes npm exigem correção de caminhos ELF com `patchelf` devido ao padrão não padrão de diretórios do Termux (`/data/data/com.termux/files/usr`).
* **Codex CLI e Antigravity CLI:** O Codex CLI oficial da OpenAI é executado em nuvem ou como cliente de API em Python/Node. O Antigravity CLI (`agy`) utiliza runtime Node/Python. Se forem puramente scripts JavaScript/Python, podem iniciar no Termux. Porém, se dependerem de binários nativos compilados para GNU/Linux x86_64 (`glibc`), eles não rodam diretamente na biblioteca C do Android (`Bionic libc`), exigindo emuladores pesados como PRoot ou Box64.
* **Compilação do `node-pty` no Android:** O Orquestra desktop depende criticamente do `node-pty` para emular terminais interativos. No Android:
  * Não existe suporte a **Windows ConPTY** (recurso exclusivo do kernel Windows).
  * O `node-pty` nativo compila para POSIX PTYs (`openpty`/`pts`). No Termux, compilar o `node-pty` via `node-gyp` falha por padrão porque o módulo procura cabeçalhos de sistema padrão da glibc que não existem na Bionic libc do Android ([GitHub - node-pty issue #395](https://github.com/microsoft/node-pty/issues/395)). Forks específicos e utilitários da comunidade como `pty-termux-utils` ([npm - pty-termux-utils](https://www.npmjs.com/package/pty-termux-utils)) são necessários para fazer pseudoterminais funcionarem em Node.js no Android.

### 1.2 Restrições do Sistema Operacional e Limitações Físicas
* **Phantom Process Killer (Android 12+):** Introduzido no Android 12, o *Phantom Process Killer* monitora processos filhos criados por aplicativos em segundo plano. Ele impõe um teto rígido de **32 processos filhos simultâneos** em todo o sistema e mata agressivamente árvores de processos com alto consumo de CPU ([Andronix - Phantom Process Killer Guide](https://docs.andronix.app/android-12/phantom-process-killer)). Agentes de codificação de IA frequentemente invocam árvores profundas de processos (Node, Python, Git, Language Servers, compilações, testes unitários). Quando o limite é atingido, o Android encerra o processo sumariamente com `signal 9 (SIGKILL)`. A desativação desse mecanismo exige comandos via ADB (`adb shell device_config put activity_manager max_phantom_processes 2147483647`) ou opção oculta no modo de desenvolvedor do Android 14+.
* **Doze Mode e Battery Optimization:** O Android congela ou suspende conexões de rede e execução de CPU quando a tela desliga. Manter um agente executando tarefas longas de 10 a 30 minutos em segundo plano exige `WakeLock` contínuo (`termux-wake-lock`), provocando consumo drástico de bateria e aquecimento severo do dispositivo (*thermal throttling*), o que reduz o clock do processador.
* **Armazenamento e Ferramental de Desenvolvimento:** Um ambiente de desenvolvimento real exige Git, compiladores, dependências `node_modules` massivas, interpretadores Python e utilitários Unix. Em dispositivos móveis, o sistema de arquivos flash (UFS/eMMC) sofre com operações intensivas de I/O de milhares de arquivos pequenos gerados por builds e instalações de pacotes.

**Conclusão da Execução Local:** Embora seja um experimento técnico interessante no Termux para usuários avançados dispostos a usar ADB e scripts de ajuste, é inviável como base de um produto para usuários comuns.

---

## 2. Políticas da Google Play Store

Se o Orquestra pretendesse empacotar um runtime local para baixar e executar CLIs e ferramentas de desenvolvimento na Google Play Store, enfrentaria rejeição imediata pelas políticas da plataforma.

### 2.1 Política de "Device and Network Abuse"
A documentação oficial para desenvolvedores da Google Play estabelece regras estritas sobre a execução de código baixado ([Google Play Developer Policy - Device and Network Abuse](https://support.google.com/googleplay/android-developer/answer/9888379)):
> *"An app distributed via Google Play may not modify, replace, or update itself using any method other than Google Play's update mechanism. Likewise, an app may not download executable code (such as dex, JAR, .so files) from a source other than Google Play."*

* **O que é proibido:** Baixar binários executáveis compilados, bibliotecas compartilhadas `.so`, arquivos `.dex` ou executáveis nativos pela internet e executá-los em tempo de execução.
* **Exceções limitadas:** Interpretadores de código (como JavaScript dentro de um WebView seguro ou interpretadores de scripts educacionais como Lua/Python) são tolerados apenas se o código executado não violar outras políticas, não contornar o sandbox do sistema operacional e não fornecer acesso direto sem restrições a chamadas de baixo nível do sistema operacional.
* **Impacto no Orquestra:** Um app que faça o download de pacotes npm de terceiros contendo binários nativos ARM, ou que baixe CLIs executáveis de servidores externos para rodar no terminal, viola diretamente essa cláusula.

### 2.2 O Caso Histórico do Termux (Por que saiu da Play Store?)
O Termux é o caso paradigmático de conflito entre ferramentas de terminal e as políticas da Google Play ([Termux Wiki - Google Play Deprecation](https://github.com/termux/termux-app#google-play-store-deprecated)):
1. **Restrições de W^X (Android 10 / API 29):** A partir do Android 10, o Google implementou a política de segurança W^X (*Write XOR Execute*). Sob essa regra, arquivos localizados no diretório de dados privados do aplicativo (`/data/data/com.termux/`) não podem ter simultaneamente permissão de escrita e execução. Chamar a syscall `execve()` em qualquer arquivo dentro do armazenamento privado do app retorna erro `EACCES (Permission Denied)`.
2. **Exigência de `targetSdkVersion`:** A Google Play exige anualmente que todos os aplicativos atualizem seu `targetSdkVersion` para as versões recentes do Android (atualmente Android 14 / API 34).
3. **O Conflito Insuperável:** Como o gerenciador de pacotes do Termux (`apt`/`pkg`) precisa baixar binários e executá-los dentro de seu prefixo de usuário, atualizar o `targetSdkVersion` para 29+ quebrava a capacidade de executar qualquer comando baixado. Para continuar funcionando, o Termux precisava manter `targetSdkVersion 28` (Android 9).
4. **Desfecho:** O Google bloqueou atualizações de apps que não cumprissem o `targetSdkVersion` mínimo. Consequentemente, o Termux foi congelado e descontinuado na Play Store em 2020, migrando sua distribuição oficial para o **F-Droid** e **GitHub Releases**, onde não há restrições de `targetSdkVersion` e o usuário faz *sideload* por conta própria.

**Conclusão sobre a Play Store:** Qualquer aplicativo que funcione como um terminal aberto que baixa e roda CLIs nativas não pode ser publicado na Google Play Store sem violar as regras atuais. Por outro lado, um aplicativo móvel que atua como **cliente de controle remoto** (conectando-se a um servidor desktop) é 100% compatível com todas as políticas da Play Store.

---

## 3. Arquitetura de "Controle Remoto" do Desktop

No modelo de controle remoto, o computador desktop continua sendo a máquina anfitriã (rodando Windows, Node.js, `node-pty`, ConPTY e os agentes com acesso completo aos arquivos do projeto), enquanto o celular atua como uma interface de visualização, interação e aprovação em tempo real.

```
+-------------------------------------------------------------+
|                     SMARTPHONE ANDROID                      |
|  [ Interface React / Canvas (@xyflow) ]  [ xterm.js Term ]  |
+-------------------------------------------------------------+
                              |
                     Canal Seguro (WSS / E2EE)
                              |
+-------------------------------------------------------------+
|                      INTERNET / REDE                        |
|   (Opção A: Tailscale P2P | Opção B: Cloudflare | Opção C: Relay)   |
+-------------------------------------------------------------+
                              |
+-------------------------------------------------------------+
|                     DESKTOP (WINDOWS)                       |
|   [ Orquestra Host ] <---> [ node-pty (ConPTY) ]            |
|                                |                            |
|                     [ Claude / Codex / Agy ]                |
+-------------------------------------------------------------+
```

### 3.1 Tecnologias de Conectividade: Rede Local vs. Fora de Casa

| Tecnologia | Como Funciona | Prós | Contras |
| :--- | :--- | :--- | :--- |
| **Rede Local (Wi-Fi LAN)** | O host desktop abre um servidor HTTP/WebSocket na porta local (ex.: porta 4488). Descoberta automática via mDNS/Bonjour. | Conexão direta, latência mínima (<5ms), sem intermediários ou custo. | Só funciona enquanto o smartphone estiver no mesmo Wi-Fi de casa/escritório. |
| **Tailscale (WireGuard Mesh)** | Cria uma rede privada virtual (VPN mesh) ponto a ponto usando criptografia WireGuard (Noise Protocol). NAT traversal com STUN/DERP ([Tailscale Docs](https://tailscale.com/kb/1151/what-is-tailscale)). | P2P direto, extremamente seguro, tráfego criptografado sem exposição pública de portas. | Exige que o usuário instale o app do Tailscale no celular e no PC e faça login na mesma conta. |
| **Cloudflare Tunnel (`cloudflared`)** | O PC desktop abre um túnel de saída seguro para a borda da Cloudflare ([Cloudflare Tunnel Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)). O celular acessa via HTTPS/WSS público com Cloudflare Access (Zero Trust). | Acessível de qualquer navegador ou app sem VPN instalada no celular; suporte nativo a WebSockets. | Tráfego transita pela infraestrutura da Cloudflare; exige domínio próprio configurado no DNS da Cloudflare. |
| **Relay Próprio com E2EE (Padrão Happy)** | Um servidor leve (VPS ou Serverless) faz o roteamento cego de WebSockets entre PC e celular. As mensagens são cifradas de ponta a ponta ([Happy Engineering Architecture](https://happy.engineering/)). | Pareamento instantâneo via QR Code (troca de chaves públicas); o relay não lê dados; zero configuração de rede para o usuário. | Necessidade de hospedar e manter o serviço de relay em nuvem. |

### 3.2 Autenticação e Criptografia
* **Pareamento por Chave Criptográfica:** O desktop exibe um QR Code contendo o endereço de conexão e uma chave de sessão pré-compartilhada (PSK) ou chave pública.
* **Criptografia em Trânsito:** Uso obrigatório de TLS/HTTPS ou túnel WireGuard. Em caso de relay público intermediário, implementação de cifragem ponta a ponta (E2EE) com libsodium/X25519 para que nem mesmo o operador do relay veja comandos ou saídas do terminal.
* **Controle de Sessão:** Tokens de curta duração (JWT) renovados via WebSocket com permissão de revogação imediata a partir do desktop.

### 3.3 Notificações Push: Avisando o Usuário ("Aguardando Você")
Um dos pontos fortes do Orquestra é o estado periférico em que agentes sinalizam que concluíram um turno ou estão aguardando confirmação do usuário (ex.: autorização de comando, permissão de arquivo ou pergunta interativa).
* **Firebase Cloud Messaging (FCM):** O padrão da indústria no Android ([Firebase Cloud Messaging Docs](https://firebase.google.com/docs/cloud-messaging)). Quando o host no desktop detecta que um terminal mudou seu estado para `waiting` ("aguardando você"):
  1. O desktop dispara um webhook seguro para o serviço de mensageria contendo o ID do terminal e a mensagem de contexto.
  2. O FCM envia um pacote de dados em alta prioridade para o token de registro do smartphone.
  3. O Android exibe uma notificação nativa com botões rápidos de ação (ex.: "Aprovar", "Ver Terminal").
* **UnifiedPush:** Alternativa de código aberto sem dependência dos Google Play Services (útil para distribuições no F-Droid), utilizando servidores de notificação como ntfy.sh ou Nextcloud ([UnifiedPush Docs](https://unifiedpush.org/)).

---

## 4. Stack do App Android Reaproveitando o React do Desktop

O Orquestra desktop possui uma interface rica construída em **React 18**, `@xyflow/react` (canvas de nós), `@xterm/xterm` (terminais) e componentes CSS personalizados. A escolha da stack móvel define a viabilidade técnica e a taxa de reaproveitamento desse código.

### 4.1 Comparativo de Tecnologias

#### 1. Capacitor (Recomendada)
* **Como funciona:** Empacota a aplicação web existente dentro de um container nativo Android utilizando o componente oficial `WebView` do sistema operacional ([Capacitor Documentation](https://capacitorjs.com/docs)).
* **Reaproveitamento de código:** **90% a 95%**. Toda a árvore React (`Canvas.tsx`, `@xyflow/react`, `RemovableEdge.tsx`, formulários, temas de CSS e renderizadores) roda diretamente no WebView sem reescrita de sintaxe.
* **Integração nativa:** Plugins oficiais robustos para notificações push (`@capacitor/push-notifications`), feedback tátil/vibração (`@capacitor/haptics`), armazenamento seguro e controle de barra de status.
* **Veredito:** Melhor equilíbrio entre produtividade, reutilização imediata do código do Orquestra e acesso aos recursos de hardware do Android.

#### 2. Progressive Web App (PWA)
* **Como funciona:** A aplicação web é servida pelo desktop (ou hospedada em um domínio) e adicionada à tela inicial do Android via Chrome/Samsung Internet ([MDN Web Docs - Progressive Web Apps](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps)).
* **Reaproveitamento de código:** **95% a 98%**. Praticamente idêntico ao desktop.
* **Limitações:**
  * No Android, PWAs suportam **Web Push API** via Service Workers ([Chrome for Developers - Web Push Notifications](https://developer.chrome.com/docs/capabilities/web-apis/push-api)), mas conexões WebSocket em tempo real são congeladas assim que o app vai para segundo plano.
  * Menor controle sobre a barra de navegação, teclado virtual e ausência de APIs avançadas de sistema.
  * Requer configuração HTTPS válida em domínio ou IP local com certificados aceitos pelo navegador.

#### 3. Tauri Mobile v2
* **Como funciona:** Semelhante conceitualmente ao Capacitor, renderiza o frontend web em um WebView Android, mas substitui a camada nativa/Node por um backend em **Rust** ([Tauri v2 Mobile Documentation](https://v2.tauri.app/start/frontend/)).
* **Prós:** Binários compactos, consumo de memória ligeiramente menor no lado nativo.
* **Contras:** O Orquestra é um projeto baseado em ecossistema TypeScript/Node. Adicionar Rust para lidar com plugins Android e WebSocket no mobile introduz complexidade desnecessária de compilação sem trazer ganho perceptível sobre o Capacitor para esse caso de uso.

#### 4. React Native
* **Como funciona:** Compila componentes para primitivas visuais 100% nativas do Android (`View`, `Text`, `ScrollView`), sem motor de renderização HTML/DOM.
* **Reaproveitamento de código:** **Menos de 20%**. Apenas a lógica pura de TypeScript (estados, cálculos matemáticos, formatadores) pode ser compartilhada.
* **Incompatibilidade direta:** O `@xyflow/react` depende visceralmente da DOM (elementos `div`, SVG, manipulação de nós HTML). Não existe React Flow nativo para React Native; o canvas precisaria ser reescrito do zero com bibliotecas de renderização gráfica como React Native Skia ou SVG. O mesmo vale para o xterm.js.
* **Veredito:** Inviável pelo esforço astronômico de desenvolvimento.

### 4.2 Desafios de UX em Mobile: Canvas e Terminais

| Componente | Desafio no Smartphone | Solução Técnica |
| :--- | :--- | :--- |
| **Canvas (@xyflow/react)** | Conflito entre o scroll da página e os gestos de pan/zoom; telas de celular são pequenas para grafos grandes. | O `@xyflow/react` possui suporte nativo a toque (`panOnDrag={true}`, `zoomOnPinch={true}`) ([React Flow Mobile Guide](https://reactflow.dev/learn/advanced-use/mobile)). Em telas móveis, recomenda-se adicionar um botão de navegação "Fit View" e fornecer um modo de visualização alternativo em lista/cards para telas estreitas. |
| **Terminal (xterm.js em WebView)** | O Chromium do Android às vezes não abre o teclado virtual ao tocar no terminal porque a textarea auxiliar (`.xterm-helper-textarea`) tem opacidade zero ou posição fora da tela ([xterm.js Issue #2799](https://github.com/xtermjs/xterm.js/issues/2799)). | Forçar o foco no evento `touchend` e desativar atributos de predição de texto (`autocomplete="off"`, `autocorrect="off"`, `spellcheck="false"`) na textarea interna do xterm. |
| **Teclado Virtual (Redimensionamento)** | Ao abrir o teclado, o viewport do Android encolhe drasticamente (diminuindo o espaço do terminal ou quebrando a escala do canvas). | Configurar no AndroidManifest `android:windowSoftInputMode="adjustResize"` e usar a API CSS `dvh` / `env(keyboard-inset-height)` para reposicionar a barra de comandos sem distorcer o grafo. |
| **Teclas Especiais (`Ctrl`, `Esc`, Setas)** | Teclados padrão do Android (Gboard/SwiftKey) não possuem teclas essenciais para interagir com CLIs de agentes (`Esc` para interromper, `Ctrl+C`, setas para navegar menus interativos). | Adicionar uma **barra de acessórios virtual** fixa imediatamente acima do teclado com botões dedicados: `[Esc]`, `[Tab]`, `[Ctrl]`, `[▲]`, `[▼]`, `[Enter]` (padrão utilizado por apps como Termius e JuiceSSH). |

---

## 5. Exemplos Existentes no Mercado e Referências

O mercado de ferramentas para desenvolvedores já validou amplamente o modelo de cliente móvel conectado a agentes remotos.

### 5.1 Happy (happy.engineering)
* **O que é:** Aplicativo de código aberto voltado para controle móvel do **Claude Code** e agentes de IA ([GitHub - slopus/happy](https://github.com/slopus/happy)).
* **Como funciona:** O desenvolvedor instala uma CLI no computador desktop (`npm install -g happy`) e roda `happy claude`. A CLI inicia um túnel WebSocket com criptografia ponta a ponta (E2EE) conectado a um servidor de relay.
* **Experiência móvel:** O usuário escaneia um QR Code no app do celular (iOS/Android). O celular recebe notificações push sempre que o Claude Code faz uma pergunta, solicita autorização de comando bash ou conclui uma tarefa, permitindo aprovar alterações e responder perguntas de qualquer lugar.

### 5.2 Termius e JuiceSSH
* **O que são:** Os dois clientes de terminal/SSH mais populares do Android ([Termius](https://termius.com/), [JuiceSSH](https://juicessh.com/)).
* **Arquitetura:** Conectam-se via protocolo SSH a servidores ou computadores remotos onde os processos reais são executados.
* **Destaques de UX:** Implementam barras virtuais completas para teclas modificadoras (`Ctrl`, `Alt`, `Esc`, `Tab`), suporte a multiplexação (`tmux`), persistência de conexões em segundo plano via serviços em primeiro plano (*Foreground Services*) e esquemas de cores customizados.

### 5.3 code-server e VS Code Remote Tunnels
* **code-server (Coder):** Roda o VS Code em uma máquina Linux/Windows remota e serve a interface completa via navegador web ([GitHub - coder/code-server](https://github.com/coder/code-server)). Em smartphones e tablets, pode ser instalado como PWA.
* **VS Code Remote Tunnels:** Recurso nativo da Microsoft (`code tunnel`) que cria um túnel seguro entre o desktop local e a interface web `vscode.dev` ([VS Code Docs - Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels)). Usuários conseguem inspecionar arquivos, rodar terminais e interagir com extensões de IA no celular sem abrir portas no roteador.

### 5.4 Codex no App do ChatGPT (OpenAI)
* **Como funciona:** O app móvel do ChatGPT permite executar códigos em Python e tarefas automatizadas, mas toda a computação ocorre em containers isolados na nuvem da OpenAI. A aplicação Android é apenas uma interface de conversação leve que renderiza texto formatado, código e imagens.

---

## Tabela Comparativa de Opções de Stack para o Orquestra

| Opção | Reaproveitamento do Código Atual | Esforço Estimado | Riscos Principais | Recomendação |
| :--- | :---: | :---: | :--- | :---: |
| **Capacitor (App Android Nativo)** | **Alto (~90-95%)**<br>(Reaproveita React, Canvas, CSS e componentes web) | **Médio**<br>(Configuração do projeto Android, plugins nativos e layouts touch) | Gestão de teclado virtual sobre o xterm.js; renderização de canvas denso em dispositivos de entrada. | **Altamente Recomendada**<br>(Permite distribuição na Google Play, notificações FCM nativas e atalhos rápidos) |
| **PWA (Web App Progressivo)** | **Máximo (~95-98%)**<br>(Praticamente o mesmo bundle web) | **Baixo**<br>(Adicionar Web Manifest e Service Worker no host desktop) | Desconexão de WebSockets em background; dependência de HTTPS/domínio público configurado pelo usuário. | **Excelente como MVP**<br>(Pode ser disponibilizado imediatamente pelo servidor web local do Orquestra) |
| **Tauri Mobile v2** | **Alto (~90%)**<br>(Reaproveita o frontend React) | **Alto**<br>(Necessidade de manter bindings em Rust e toolchain NDK/Gradle) | Ecossistema móvel jovem; documentação de plugins Android menos madura que Capacitor. | **Não recomendada para esta fase** |
| **React Native** | **Muito Baixo (<20%)**<br>(Apenas funções utilitárias e estados puros) | **Crítico / Reescrita Total**<br>(Reescrever canvas e terminais do zero) | Ausência de suporte ao `@xyflow/react`; custo de desenvolvimento proibitivo. | **Inviável** |
| **Execução Nativa no Termux** | **Médio no backend (~50%)**<br>(Reaproveita Node, mas sem ConPTY e sem Electron) | **Muito Alto**<br>(Adaptação profunda para Bionic libc e arquitetura ARM) | Bloqueado na Google Play; Phantom Process Killer mata processos; alto consumo térmico/bateria. | **Inviável como produto comercial** |

---

## Lista Consolidada de Fontes e Referências

1. **Execução Local, Termux e Android:**
   * *Running Claude Code on Android via Termux:* https://www.builder.io/blog/claude-code-android-termux
   * *Claude Code Android Wrapper (ferrumclaudepilgrim):* https://github.com/ferrumclaudepilgrim/claude-code-android
   * *Microsoft node-pty Issue #395 (Android/Bionic compatibility):* https://github.com/microsoft/node-pty/issues/395
   * *pty-termux-utils on npm:* https://www.npmjs.com/package/pty-termux-utils
   * *Andronix - Android 12 Phantom Process Killer:* https://docs.andronix.app/android-12/phantom-process-killer
2. **Políticas da Google Play Store:**
   * *Google Play Policy - Device and Network Abuse:* https://support.google.com/googleplay/android-developer/answer/9888379
   * *Termux Repository - Deprecation on Google Play Store:* https://github.com/termux/termux-app#google-play-store-deprecated
   * *Android 10 W^X / execve restrictions discussion (Termux issue #1072):* https://github.com/termux/termux-app/issues/1072
3. **Rede, Túneis e Mensageria:**
   * *Tailscale Technology and WireGuard Mesh:* https://tailscale.com/kb/1151/what-is-tailscale
   * *Cloudflare Tunnel Documentation:* https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
   * *Firebase Cloud Messaging (FCM) Architecture:* https://firebase.google.com/docs/cloud-messaging
   * *UnifiedPush Open Standard:* https://unifiedpush.org/
4. **Stacks Frontend e Mobile:**
   * *Capacitor by Ionic:* https://capacitorjs.com/docs
   * *React Flow (@xyflow/react) Mobile & Touch Features:* https://reactflow.dev/learn/advanced-use/mobile
   * *xterm.js Mobile & Virtual Keyboard Issue #2799:* https://github.com/xtermjs/xterm.js/issues/2799
   * *Tauri v2 Mobile Documentation:* https://v2.tauri.app/start/frontend/
   * *MDN Progressive Web Apps Documentation:* https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps
5. **Apps Similares e Referências de Mercado:**
   * *Happy - Mobile Client for Claude Code:* https://happy.engineering/ e https://github.com/slopus/happy
   * *Termius Mobile SSH Client:* https://termius.com/
   * *JuiceSSH Android SSH Client:* https://juicessh.com/
   * *coder/code-server:* https://github.com/coder/code-server
   * *VS Code Remote Tunnels:* https://code.visualstudio.com/docs/remote/tunnels
