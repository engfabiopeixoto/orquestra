# Orquestra - Especificação Técnica: Suporte a Dispositivos Android Nativos

Este documento descreve a arquitetura recomendada para estender o **Portal de Navegador** do Orquestra com suporte a dispositivos físicos e emuladores Android nativos.

## 1. Visão Geral

A entrega atual do Orquestra 0.3.0 foca em **emulação de navegador responsivo de alta fidelidade** diretamente no Electron via `WebContentsView`, com:
- Viewport e densidade de pixels reais (deviceScaleFactor).
- Eventos de toque simulados (Touch Events).
- User Agent móvel autêntico.
- Orientação Retrato / Paisagem com rotação dinâmica.

Essa abordagem não exige Android SDK, Java, NDK ou emuladores pesados instalados na máquina do usuário.

Para casos em que o usuário precisa executar e inspecionar **aplicativos Android nativos** (.apk) ou navegadores reais do sistema operacional Android (ex: Chrome for Android, WebView do sistema), a arquitetura abaixo deve ser adotada.

---

## 2. Arquitetura Proposta para Dispositivos Android

### 2.1 Descoberta e Comunicação com Dispositivos (ADB)
- Utilizar a biblioteca `adbkit` ou o binário empacotado `adb.exe` via socket bridge.
- Listagem de dispositivos conectados via USB ou Wi-Fi (`adb devices -l`).
- Encaminhamento de portas (`adb forward` / `adb reverse`) para testes de serviços rodando em `localhost`.

### 2.2 Streaming e Visualização no Canvas
Para exibir a tela do dispositivo Android dentro do nó do canvas sem latência:
1. **Scrcpy Server (Recomendado)**:
   - Enviar o binário leve `scrcpy-server.jar` para o dispositivo via ADB.
   - Capturar o feed de vídeo H.264 / H.265 via socket TCP.
   - Decodificar no nó do renderer via WebCodecs ou canvas 2D/WebGL em tempo real (< 30ms de latência).
2. **Fallback via Screencap**:
   - `adb exec-out screencap -p` para capturas periódicas caso scrcpy não esteja disponível.

### 2.3 Entrada e Interatividade
- **Cliques e Toques**:
  - Mapear coordenadas do elemento React Flow para a resolução nativa do Android (`adb shell input tap X Y` ou injeção de eventos via protocolo do scrcpy).
- **Gestos e Swipe**:
  - Mapear arrasto do mouse para `adb shell input swipe X1 Y1 X2 Y2 [duration_ms]`.
- **Teclado**:
  - `adb shell input text <string>` ou envio de keycodes (`KEYCODE_BACK`, `KEYCODE_HOME`, `KEYCODE_APP_SWITCH`).

### 2.4 Inspeção e Depuração (Chrome DevTools Protocol)
- Para webviews ou Chrome no Android:
  - `adb forward tcp:9222 localabstract:chrome_devtools_remote`.
  - Conectar cliente CDP para inspecionar DOM, console e rede diretamente a partir do Orquestra.

---

## 3. Diretrizes de Implementação Futura
- **Isolamento Modular**: Manter o cliente ADB em um processo auxiliar (worker/sidecar) para não bloquear o loop de eventos principal do Electron.
- **Detecção Graciosa**: O nó do portal deve indicar se o ADB está instalado e configurado, sem falhar se não houver dispositivos conectados.
- **Segurança**: Nunca conceder permissões elevadas sem autorização explícita do desenvolvedor.
