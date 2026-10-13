# Fluxo visual do Orquestra

O canvas combina terminais, anotações, grupos e um grafo de processamento. As conexões de conversa continuam disponíveis. Conexões de dados são azuis, têm direção e ligam uma saída à direita a uma entrada à esquerda. Não há integração com Revit ou IronPython.

## Uso

1. Abra um projeto e use **+ Nó**. **Criar exemplo 3D** adiciona uma entrada numérica, um algoritmo JavaScript e uma visualização conectados.
2. Use **Executar** para processar o grafo. O botão de execução de um nó executa esse nó e suas dependências.
3. Clique em uma porta para inspecionar seu valor, tamanho e versão. Resultados podem ser apresentados como JSON, tabela, gráfico ou geometria 3D.
4. Edite um nó pelo menu do cabeçalho. Defina os nomes, tipos, unidades, valores padrão, limites em bytes e validações de cada porta.
5. Arraste uma saída até uma entrada. Cada entrada aceita uma ligação. Ciclos, tipos incompatíveis e referências ausentes são rejeitados.
6. Para exportar, inspecione uma saída, informe um caminho relativo ao projeto, confira a prévia e use **Aplicar exportação**. Executar um nó de saída apenas prepara dados.

## Algoritmos

Python 3 é opcional e pode ser configurado por executável. JavaScript usa o Node disponível no aplicativo. Os algoritmos recebem `IN`, um objeto com as entradas nomeadas, e retornam um objeto com as saídas declaradas. Também podem atribuir `OUT`.

```python
def run(IN):
    return {"saida": IN["valor"] * 2}
```

```javascript
function run(IN) {
  return {saida: IN.valor * 2};
}
```

JavaScript é síncrono, executado em contexto novo com `IN`, `OUT` e `console.log`; `require`, rede e Promises não fazem parte dessa interface. Python admite módulos instalados e arquivos do projeto. Scripts locais são código executável do usuário; os processos não constituem uma sandbox de sistema operacional.

Um caminho de script relativo substitui o código do editor. Declare arquivos auxiliares no campo de dependências para invalidar o cache quando mudarem. O cache considera código, runtime, configuração, contratos, entradas e hashes desses arquivos. Desative **Resultado determinístico** em algoritmos com efeitos colaterais ou dependências não declaradas.

Casos de teste são uma lista JSON:

```json
[
  {
    "title": "Dobro de três",
    "inputs": {"valor": 3},
    "expected": {"saida": 6}
  }
]
```

Comparações numéricas usam a tolerância configurada. **Histórico** guarda as últimas 20 execuções e compara mudanças na configuração/código e nos hashes de saída. Mover um nó não invalida seus resultados.

A validação de contratos aceita um subconjunto explícito de JSON Schema: `type`, `properties`, `required`, `items`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems` e `additionalProperties: false`, além de `title` e `description`. Palavras não suportadas produzem erro, evitando uma validação parcial silenciosa. Entrada/arquivo são fontes; validação, teste, visualização e saída recebem uma única entrada. Use algoritmos ou etapas de agente para combinar várias entradas nomeadas.

## Etapas de agente

> Desativadas temporariamente: a interface de E/S dos agentes está oculta pela flag `AGENT_FLOW_IO` em `packages/app/src/renderer/src/flow/feature-flags.ts`.

Terminais de agentes apresentam **Configurar E/S**. Cada etapa recebe apenas as entradas e instruções declaradas pelo grafo e deve responder com um objeto JSON que satisfaça as portas de saída. O contexto transmitido é limitado a 64 KiB; a resposta a 128 KiB. A lista de arquivos é uma instrução de contexto ao agente, não uma restrição de acesso do sistema operacional.

**Auto local** recalcula somente nós cujos predecessores sejam locais e determinísticos. Etapas de agentes exigem execução explícita. Cancelar um fluxo interrompe a espera por um agente; um pedido já iniciado no terminal pode continuar. Contadores mostram chamadas e bytes enviados/recebidos, não uma estimativa de tokens faturados.

## Geometria e visualizações

A geometria usa `units` (`m`, `cm`, `mm`, `ft`), `origin`, `items` e uma transformação opcional com 16 números em ordem de colunas. A prévia usa Z para cima e converte as unidades para metros. Itens podem ser pontos, linhas ou malhas triangulares:

```json
{
  "units": "m",
  "origin": [0, 0, 0],
  "items": [
    {"kind": "line", "id": "segmento", "color": "#7aa7ff", "points": [[0, 0, 0], [1, 0, 1]]}
  ]
}
```

Uma malha usa `vertices` e `faces`, uma lista de trios de índices. A prévia admite até 100 mil pontos/vértices combinados. Ela é criada ao abrir o inspetor, desenha sob demanda e libera recursos de GPU ao fechar. Tabelas mostram até 500 linhas; gráficos até 1000 valores, pares `[x,y]` ou objetos com `x` e `y`.

## Persistência e recursos

O grafo fica em `.orquestra/workspace.json`. Resultados ficam em `.orquestra/flow/objects`, identificados por hash; o canvas recebe apenas pequenas prévias. O histórico fica em `.orquestra/flow/runs`; os arquivos de objetos podem continuar no disco após sair do histórico.

Há no máximo três workspaces e dois workers de algoritmo compartilhados, com fila de até 32 trabalhos. Workers ociosos são liberados após 60 segundos. JavaScript tem heap de 128 MiB; Python não tem cota rígida de RAM. Tempos máximos, limites de conteúdo e quantidade de workers reduzem consumo, mas o algoritmo escolhido ainda determina sua demanda de memória.

Um nó admite até 16 entradas e 16 saídas. A porta usa limite padrão de 64 KiB, configurável até 4 MiB. Arquivos maiores podem passar como referência com caminho, hash e tamanho. O grafo admite até 200 nós e 1000 conexões.

Exportações ficam dentro do projeto e fora dos arquivos internos `.orquestra`. A aplicação verifica se o destino e o resultado continuam iguais aos da prévia antes de escrever.
