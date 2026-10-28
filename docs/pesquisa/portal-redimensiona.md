# Investigação: portal redimensiona ao sair da área visível

## Conclusão

**Causa raiz:** `PortalNode` intersecta o retângulo DOM do nó com a área do canvas e com controles sobrepostos. Ele envia a interseção como bounds do portal, em vez do retângulo lógico inteiro do nó ([PortalNode.tsx:117-155](../../packages/app/src/renderer/src/portal/PortalNode.tsx)).

O main process aplica esses bounds diretamente ao `WebContentsView` por `setBounds` ([portal-manager.ts:236-255](../../packages/app/src/main/portal/portal-manager.ts), [portal-view.ts:256-267](../../packages/app/src/main/portal/portal-view.ts)). No modo desktop, o tamanho do viewport Chromium acompanha o tamanho nativo; ao esconder metade do nó, a página recebe metade da largura CSS e reflui.

Não é `setZoomFactor`: não há chamada a `setZoomFactor`/`setZoomLevel` no caminho do portal. O zoom do canvas transforma a geometria DOM; essa geometria transformada é então medida e passada como bounds ([PortalNode.tsx:35,117-155,187](../../packages/app/src/renderer/src/portal/PortalNode.tsx)).

## Caminho dos bounds e frequência

1. `PortalNode` lê o retângulo renderizado do elemento do portal via `getBoundingClientRect()` e o retângulo de `.canvas` ([PortalNode.tsx:115-123](../../packages/app/src/renderer/src/portal/PortalNode.tsx)). Como o React Flow aplica pan/zoom ao viewport, esse retângulo já está em coordenadas visuais da janela.
2. Calcula interseção por `max(left/top)` e `min(right/bottom)`. Também corta a região quando ela cruza `.palette`, `.group-tools`, `.flow-toolbar`, `.zoom-control` ou `.subscription-usage` ([PortalNode.tsx:125-134](../../packages/app/src/renderer/src/portal/PortalNode.tsx)).
3. Se a interseção é vazia, envia tamanho zero e `visible: false`; se é parcial, envia a largura/altura da interseção e `visible: true` ([PortalNode.tsx:136-157](../../packages/app/src/renderer/src/portal/PortalNode.tsx)). Portanto, o clipping é realizado encolhendo o `WebContentsView`, não por uma máscara/recorte nativo.
4. `syncBounds` é enviado pelo bridge IPC do renderer e tratado pelo handler `orq:portal:sync-bounds` ([portal-bridge.ts:93-98](../../packages/app/src/renderer/src/portal/portal-bridge.ts), [portal-ipc.ts:61-67](../../packages/app/src/main/portal/portal-ipc.ts)). O `PortalManager` guarda os bounds, chama `activeView.setBounds()` e decide visibilidade ([portal-manager.ts:236-255](../../packages/app/src/main/portal/portal-manager.ts)).
5. `PortalView.setBounds()` arredonda as coordenadas e dimensões e chama `this.view.setBounds()`; não muda o zoom da página ([portal-view.ts:256-267](../../packages/app/src/main/portal/portal-view.ts)).

O sincronizador roda no primeiro efeito, em `ResizeObserver`, em `scroll`/`resize`, e em `pointermove` limitado a no máximo um `requestAnimationFrame` pendente. Também é reinstalado quando `viewport.x`, `viewport.y` ou `viewport.zoom` mudam ([PortalNode.tsx:108-187](../../packages/app/src/renderer/src/portal/PortalNode.tsx)). Assim, durante pan/drag com movimento do ponteiro, pode atualizar até uma vez por frame; o guard `previousBounds` evita IPC se os bounds calculados não mudaram ([PortalNode.tsx:144-157,168-178](../../packages/app/src/renderer/src/portal/PortalNode.tsx)).

O `WebContentsView` é adicionado ao `contentView` da janela, fora da árvore DOM do renderer ([portal-manager.ts:382-388](../../packages/app/src/main/portal/portal-manager.ts)). Ele não herda `overflow: hidden`, clipping do React Flow nem a ordem z-index da sidebar; a implementação tenta simular clipping alterando bounds e ocultando a view quando não há interseção. A sincronização compara controles específicos e a área `.canvas`; isso não equivale a clipping DOM geral de qualquer overlay ([PortalNode.tsx:119-155](../../packages/app/src/renderer/src/portal/PortalNode.tsx)).

### Zoom e modo mobile

No modo desktop, zoom/pan do canvas altera a posição e o tamanho visual do nó, e esses valores vão ao `setBounds`. Em zoom menor, a própria view nativa fica fisicamente menor; em zoom maior, fica maior. A página ajusta seu viewport CSS ao novo tamanho nativo, logo pode refluir também no zoom ([PortalNode.tsx:117-155,187](../../packages/app/src/renderer/src/portal/PortalNode.tsx); [portal-view.ts:256-267](../../packages/app/src/main/portal/portal-view.ts)).

Há exceção parcial no modo mobile/emulação: `PortalView` chama `enableDeviceEmulation` com `screenSize`/`viewSize` do preset e calcula `scale` a partir dos bounds atuais ([portal-view.ts:219-254](../../packages/app/src/main/portal/portal-view.ts)). Nesse modo, o viewport emulado tende a manter as dimensões do preset, mas a escala visual ainda depende do tamanho visível recebido. O e2e já verifica viewport de 393 px em portrait e 852 px após girar para landscape ([portal.spec.ts:105-128](../../packages/app/e2e/portal.spec.ts)).

## Evidência experimental

Criei e rodei temporariamente `packages/app/e2e/portal-clipping-diagnostic.spec.ts`, usando o Electron isolado de `launchApp`, página local e portal em modo desktop. O teste moveu o viewport do React Flow até metade do nó ficar fora da borda esquerda do canvas; consultou `view.getBounds()` no processo principal e `innerWidth/innerHeight` na página do portal. Resultado impresso pelo e2e:

| Medida | Nó inteiro visível | Metade fora do canvas |
|---|---:|---:|
| `WebContentsView` bounds | `{ x: 361, y: 273, width: 798, height: 478 }` | `{ x: 220, y: 273, width: 399, height: 478 }` |
| `window.innerWidth` | `798` | `399` |
| `window.innerHeight` | `478` | `478` |

Comando: `npm run e2e -- portal-clipping-diagnostic.spec.ts`. Resultado: **1 teste passou** em 18,9 s. A largura nativa e a largura CSS reduziram exatamente pela metade; isso confirma que a página está recebendo viewport menor, não apenas sendo parcialmente escondida. O arquivo diagnóstico foi removido após a medição porque afirmava a regressão atual como comportamento esperado; não ficou teste temporário no repositório. O e2e existente confirma que o app permite inspecionar bounds nativos e `innerWidth` ([portal.spec.ts:96-110](../../packages/app/e2e/portal.spec.ts)).

## Alternativas de correção

### A. Bounds completos do nó e view nativa inteira

Enviar o retângulo visual inteiro do nó para `setBounds`, mesmo quando exceder a área do canvas. **Efeito:** pan/zoom e saída parcial mantêm a largura e o layout da página; o conteúdo não reflui. Porém a view é uma camada nativa sobre o DOM e pode cobrir sidebar, palette, barras ou outros nós; não recebe clipping do canvas. Seria necessário ocultá-la quando houver sobreposição/saída que não possa ser recortada, ou aceitar que ela pinte por cima. Ao ficar sob a sidebar, esconder a view evita capturar cliques por cima dos controles, mas o portal fica sem conteúdo até voltar a uma região livre.

### B. View viva quando cabe, captura DOM quando parcialmente cortada (recomendada)

Manter bounds completos e tamanho lógico estável na view viva. Quando houver pan/zoom com clipping ou sobreposição, capturar a página com `webContents.capturePage()` e desenhar o bitmap no DOM do nó, que já é recortado naturalmente pelo canvas/CSS; ocultar a view nativa. Reativar a view quando estiver totalmente visível, posicionada e dimensionada, sincronizando o estado antes de mostrá-la.

**Efeito:** pan/zoom não refluem o site; o snapshot acompanha visualmente e fica corretamente atrás da sidebar e dentro dos limites do canvas. Enquanto parcialmente fora ou sob controles, a página é uma imagem sem interação nem atualização dinâmica; ao retornar à área inteira, a view viva volta. Deve-se atualizar capturas durante movimento com throttling e produzir uma captura final ao parar. É a melhor combinação entre fidelidade do layout, clipping e ordem da interface, ao custo de trabalho de renderização/coordenação e possível atraso visual.

### C. Compensar com `webContents.setZoomFactor`

Electron oferece `setZoomFactor` ([documentação oficial de webContents](https://www.electronjs.org/docs/latest/api/web-contents/#contentssetzoomfactorfactor)). Seria possível ajustar zoom da página para manter `innerWidth`/`innerHeight` constantes enquanto os bounds encolhem. **Efeito:** reduz reflow por viewport, mas reduz/escala o conteúdo dentro da área menor, em vez de recortá-lo na posição correta do nó. No clipping lateral, a origem da view passa a ser a borda visível, não a borda original do portal; o trecho apresentado pode ficar visualmente deslocado ou comprimido. Também altera zoom próprio do site e mistura o zoom do canvas com o zoom web. Não corrige o problema de view nativa cobrindo sidebar. Não recomendo como solução isolada.

### D. `capturePage` sempre, sem view nativa visível

Electron permite capturar o conteúdo da página em um `NativeImage` ([documentação oficial de webContents](https://www.electronjs.org/docs/latest/api/web-contents/#contentscapturepagerect-opts)). A view pode continuar com tamanho lógico fixo, mas o renderer sempre mostra uma imagem no canvas. **Efeito:** clipping/stacking funcionam naturalmente e não há resize baseado no recorte; em troca, sites animados ficam estáticos entre capturas, input e seleção não funcionam sobre a imagem e capturas frequentes podem custar CPU. Útil como fallback durante movimento; ruim como modo permanente interativo.

### APIs/limites nativos relevantes

`WebContentsView` é uma `View` nativa cuja API de layout inclui `setBounds`, `setVisible` e `setBorderRadius`; a documentação de `View` não oferece um retângulo de clipping arbitrário equivalente ao viewport do React Flow ([View API oficial](https://www.electronjs.org/docs/latest/api/view/), [WebContentsView API oficial](https://www.electronjs.org/docs/latest/api/web-contents-view)). `setBorderRadius` só resolve cantos arredondados, não clipping por canvas/sidebar. As opções viáveis permanecem bounds/visibilidade, uma camada bitmap DOM, ou redesenhar a integração em conteúdo DOM (por exemplo iframe, com limitações de isolamento/cross-origin e sem o mesmo controle de WebContents).

## Recomendação por interação

Recomendo **B: bounds lógicos completos para a página e alternância entre view viva e captura DOM quando clipping for necessário**. O algoritmo atual deve deixar de usar o retângulo da interseção como tamanho do `WebContentsView`; a interseção serve para determinar o que pode ser mostrado, não o tamanho do viewport web.

| Ação do usuário | Resultado recomendado |
|---|---|
| **Pan** | Quando o nó está inteiro visível, a view viva acompanha o nó com o mesmo tamanho lógico. Ao cruzar borda/controle, a view é escondida e um snapshot no DOM continua sendo recortado sem cobrir os controles. |
| **Zoom do canvas** | Ajustar os bounds da view ao tamanho visual integral do nó, sem usar o retângulo de clipping. A largura CSS pode seguir o tamanho lógico fixo; trocar para snapshot durante a transformação e voltar à view viva ao estabilizar evita reflow e flicker. O nível exato de página em CSS px precisa ser definido como contrato do modo desktop. |
| **Nó parcialmente fora da área visível** | Snapshot DOM mostra a parte visível com clipping natural; página mantém layout. Snapshot não recebe interação; mostrar indicador/limitação se o usuário tentar clicar nele. |
| **Nó sob a sidebar/palette/barras** | Esconder a view viva para ela não cobrir nem capturar interação do controle; snapshot é desenhado dentro da camada DOM e fica atrás/recortado conforme stacking CSS. Ao liberar sobreposição, reativar a view viva. |

O modo snapshot deve ser transiente e limitado aos casos de clipping/movimento, pois o portal ativo precisa continuar interativo. Se o produto preferir interação contínua acima de tudo, a alternativa A (bounds inteiros) só é segura se o view puder ser ocultado sempre que cruzar uma área protegida; sem snapshot, o conteúdo desaparece durante esses trechos. A escolha entre mostrar captura temporária e esconder o portal deve ser validada visualmente antes de corrigir produção.

## Correção aplicada (v1: snapshots, substituída pela v2)

A implementação mantém o tamanho lógico inteiro do corpo do portal: `PortalNode` mede `.portal-view-container` sem intersectá-lo com o canvas, e `portalNodeBounds` converte o retângulo integral em bounds para o `WebContentsView` (`packages/app/src/renderer/src/portal/PortalNode.tsx`, `packages/app/src/renderer/src/portal/portal-presentation.ts`). A decisão pura `portalPresentation` só permite a view ao vivo quando o zoom está em 100% (tolerância 0,001), o retângulo está inteiro dentro de `.canvas`, não há sobreposição de interface e não houve movimento por 150 ms.

Nas demais condições, o main process captura a página uma vez ao sair do modo ao vivo, esconde o `WebContentsView` e mantém seus bounds; o renderer mostra a imagem no corpo DOM do nó, ou um placeholder com título/URL até existir captura (`packages/app/src/main/portal/portal-view.ts`, `portal-manager.ts`, `PortalNode.tsx` e `portal.css`). A captura também é atualizada quando a navegação termina. Ao voltar ao estado elegível, os bounds integrais são aplicados antes de tornar a view visível. Durante o modo snapshot, mudanças de geometria não enviam bounds ao main.

Em zoom diferente de 100%, a captura recebe a dica “duplo clique para interagir”; o duplo clique centraliza o nó em zoom 1 e limpa sua seleção. Limpar a seleção remove os controles de redimensionamento que atravessavam a borda do corpo e, portanto, permite que a detecção de sobreposição retorne ao modo ao vivo. Sobreposições externas, como sidebar, barras, menus e diálogos, continuam mantendo o snapshot ativo.

A cobertura inclui testes unitários da decisão e dos bounds integrais, testes do `PortalManager` para captura antes de ocultar, ausência de `setBounds` quando oculto e troca de abas, além do e2e `packages/app/e2e/portal-resize.spec.ts`. O e2e usa uma página HTTP local e confirma: view viva quando elegível; metade do nó fora resulta em view oculta e imagem DOM, sem alterar `innerWidth`; ao restaurar, a view volta com o mesmo `innerWidth`; zoom 50% mostra a dica e o snapshot; duplo clique retorna a 100% e ao modo ao vivo sem refluir a página.

## Correção aplicada (v2: moldura)

A implementação v1 baseada em capturas foi removida. Agora uma `View` nativa de moldura é filha de `win.contentView`, limitada ao retângulo de `.canvas`; cada `WebContentsView` fica como filha dela e recebe bounds do nó inteiro em coordenadas relativas. O clipping nativo esconde a parte fora da moldura sem mudar o viewport CSS e impede que a página cubra a sidebar. O e2e `packages/app/e2e/portal-resize.spec.ts` comprova essa propriedade no Electron 44.7.0: com o nó parcialmente fora, o view usa `x` negativo relativo à moldura, `innerWidth` segue igual e o pixel amostrado na sidebar não muda.

O zoom do React Flow redimensiona visualmente os bounds do filho. O host compõe `canvasZoom * portalZoom` em `webContents.setZoomFactor`, mantendo constante a largura em CSS px ao reduzir o zoom do canvas; a 50%, a página continua ao vivo e com `innerWidth` original enquanto o view ocupa metade da largura visual. A emulação mobile continua ativa e calcula a escala pelo tamanho lógico sem multiplicar novamente o zoom do canvas.

O view permanece vivo em pan, clipping parcial e zoom diferente de 100%. A `presentationTail` serializa as atualizações de bounds por portal. A visibilidade ainda é suspensa por modais/diálogos e quando o workspace/janela não está ativo. A nova cobertura unitária valida bounds relativos negativos e a composição de zoom; testes do `PortalManager` cobrem a moldura, visibilidade e o fator aplicado.

Adendo da revisão: a moldura preserva a largura do canvas, mas limita sua faixa vertical para não cobrir controles flutuantes. O topo fica abaixo de paleta/barras superiores e a base fica acima de controles inferiores, com margem de 4 px. `ResizeObserver` acompanha o canvas e os controles; um `MutationObserver` detecta inserção, remoção e alternância de visibilidade para recalcular a faixa.