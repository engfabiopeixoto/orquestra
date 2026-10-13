# Portal integrado no Orquestra 0.3.0

A integração já está aplicada em App, Canvas, Palette, main/index, preload e shared/bridge. Não é necessário aplicar patches adicionais.

Use **+ Portal** no canvas. A barra permite URL, voltar/avançar, recarregar/parar, abas, presets desktop/mobile e rotação. Mobile emula viewport e toque no Chromium; não equivale a executar Safari/iOS ou um aplicativo Android nativo.

Os módulos `main/portal` criam WebContentsView com sessão separada por workspace, sandbox, isolamento de contexto e sem acesso à bridge do Orquestra. O preload expõe apenas operações específicas do portal. IPC aceita a janela principal e seu frame principal. Navegação permite HTTP, HTTPS e about:blank.

A emulação é aplicada após dom-ready. Desativar a emulação antes da primeira página causava um crash nativo nesta versão do Electron; o PortalView guarda o preset solicitado e aplica quando a página está pronta. A escala mobile acompanha os bounds físicos do canvas.

Os retângulos são sincronizados após inicialização, pan, zoom, drag e resize, recortados contra o canvas e controles. Modais, menus, troca de workspace e fechamento ocultam ou liberam as views. Fechar um workspace destrói suas páginas nativas; os descritores ficam disponíveis para reabrir o projeto.

A configuração do portal (posição, tamanho desktop, URLs/abas, preset e orientação) fica no armazenamento local do aplicativo, associada à pasta do projeto. Ela não é transportada automaticamente quando se copia o projeto para outro computador. Cookies usam partições próprias por workspace.

Limites: três workspaces, dois portais por workspace e três abas por portal. O consumo também depende das páginas abertas. O botão de fechar portal libera suas webContents; sair do aplicativo libera todas.

Verificação: `packages/app/test/portal-*.test.ts*` e `packages/app/e2e/portal.spec.ts`. O E2E usa o aplicativo real e uma página HTTP local para verificar navegação, viewport/UA/toque mobile, rotação, desktop, ocultação em modal, persistência e encerramento.
## Conexão com agentes (0.3.1)

O navegador tem conectores laterais no cabeçalho. Arraste um conector de um terminal até o navegador, ou use a ferramenta Conectar. A indicação no cabeçalho mostra quantos agentes têm acesso. Os vínculos são salvos no workspace e reaparecem ao reabrir o projeto.

Os agentes recebem ferramentas MCP portal_list, portal_check, portal_navigate, portal_click, portal_type, portal_scroll e portal_screenshot. Também podem usar o CLI:

- orq portal list
- orq portal check <id> --chars 4000
- orq portal navigate <id> http://localhost:3000
- orq portal type <id> '#campo' 'texto'
- orq portal click <id> '#botao'
- orq portal scroll <id> 300
- orq portal screenshot <id>

O check retorna texto e seletores CSS da aba ativa; valores de campos não são incluídos. A captura retorna um caminho local de PNG. O acesso usa a credencial do terminal e exige ligação direta com aquele navegador no mesmo workspace. Desconectar revoga novos comandos. Não existe acesso genérico a JavaScript do aplicativo ou à bridge da janela principal.

Teste de ponta a ponta adicional: packages/app/e2e/portal-agents.spec.ts executa os comandos pelo CLI de um terminal real, valida formulário e PNG, restaura o vínculo após reload e confirma a recusa após desconectar.