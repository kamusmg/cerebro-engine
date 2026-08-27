<div align="center">

**Português** • [English](MEDICOES.en.md)

# 📊 O registro de medição do cerebro-engine

### Todo número que este projeto publicou, com o método, a régua e as retratações.

</div>

---

> ⬅️ **[Voltar ao README](README.md)** — o que o projeto é, como funciona e como instalar.

> **Por que este documento existe separado do README.** O README responde *"o que é e como uso"*.
> Aqui mora a outra pergunta, que é mais longa e mais importante pra quem vai confiar num número:
> *"como isso foi medido, e o que o número não diz"*. Nada foi encurtado na mudança — inclusive as
> correções em que o projeto se contradisse e teve que voltar atrás. Elas são o ativo mais caro que
> este repositório tem.

## 📊 Medido — em DOIS gabaritos, um deles held-out

| recuperador | recall | hit@3 | MRR |
|---|:---:|:---:|:---:|
| BFS do grafo (linha de base) | 15/24 | 14/24 | 0.529 |
| híbrido + rewrite + RRF | 20/24 | **19/24** | 0.653 |
| **+ BM25 com casamento por prefixo** | **20/24** | 18/24 | **0.693** |

As 4 furadas restantes são **cobertura** (símbolos Arduino/`.ino` que o parser não extrai), **não** recall.
Nos alvos que existem no grafo: **20/20**.

> 🔴 **VOCÊ NÃO CONSEGUE REPRODUZIR ESTES NÚMEROS, e é justo você saber disso antes de confiar
> neles.** Até 25/08 esta linha dizia *"reproduza com `node harness-recall.mjs`"* — e não dava:
> o gabarito aponta para repositórios **privados** do autor, então publicá-lo vazaria exatamente
> o que este repo toma o cuidado de não vazar. O harness está aqui, o método está descrito, os
> números são reprodutíveis **pelo autor** — e para você são a palavra dele.
>
> O que dá pra fazer é medir **o seu**: monte um gabarito no formato de
> [`golden-questions.example.json`](reports/golden-questions.example.json) sobre o seu próprio
> código e rode o harness. É a única medição que responde a pergunta que importa pra você.
>
> **Atalho, com o rótulo certo:** `node generate-golden.mjs <projeto>` monta um gabarito a partir
> das docstrings e dos símbolos do próprio grafo. Ele **não é cego** — as perguntas saem do mesmo
> `graph.json` que o motor consulta, e o alvo é por definição um nó que o grafo já conhece. O que
> ele mede é **cobertura**, e serve de guarda de regressão: se cair de uma versão pra outra, alguma
> coisa quebrou. O que ele **não** responde é *"o motor acha o que EU procuro"* — pra isso, escreva
> as perguntas antes de olhar o grafo.

### Os três caminhos do mesmo motor (25/08/2026)

A tabela acima mede **um** caminho. O motor é usado por três portas diferentes, e até 25/08 só a
do meio tinha número — que era citado como se descrevesse a primeira. Agora as três são medidas
lado a lado, na mesma execução:

| caminho | recall | hit@3 | MRR |
|---|:---:|:---:|:---:|
| `--termos` vindos de quem pergunta | 20/24 | 17/24 | **0.701** |
| acerto no cache de rewrite | **21/24** | 17/24 | 0.636 |
| `--sem-rewrite` (sem o braço de termos) | 17/24 | 14/24 | 0.512 |
> ⚠ **Reconferido em 26/08/2026, com a régua consertada.** O caminho de produção reproduziu na
> terceira casa: **20/24 · 17/24 · 0.701**. O baseline **não**: deu MRR **0.512** contra os 0.533
> publicados antes. Não foi o conserto da régua — o harness anterior, sem uma linha mudada, dá
> 0.512 hoje também — nem a recência, que desligada não move o número. **A causa continua
> desconhecida**, e fica escrito assim em vez de virar explicação bonita. A linha do cache não roda
> neste clone (o `.rewrite-cache.json` aqui está vazio), mas foi reconferida no motor gêmeo do autor
> e reproduziu **exata: 21/24 · 17/24 · 0.636**. E o baseline dá 0.512 nos DOIS motores hoje — dois
> códigos diferentes, mesmo número: a diferença contra o 0.533 não está no código.
>
> E os acertos são casados por **basename**: o gabarito não carrega caminho, então a pasta não é
> verificada. Um `utils.py` da pasta errada contaria. O harness agora **imprime esse número em
> toda rodada**, em vez de deixá-lo escondido no meio dos acertos que provam a pasta.

Duas leituras. **O braço de termos paga**: 3 a 4 respostas a mais que o baseline, e +0,10 a +0,17
de MRR. E o caminho de produção **troca um acerto por um ranking claramente melhor** — o que faz
sentido, porque quem pergunta conhece a conversa e escolhe identificadores melhores que um cache
congelado semanas atrás.

> ⚠️ **Medir estes dois primeiros caminhos juntos exige `CEREBRO_CACHE_RO=1`** (o harness já liga).
> Sem isso, medir o caminho `--termos` **grava os termos da medição dentro do cache de rewrite**,
> e o caminho do cache passa a devolver os mesmos termos: os dois braços viram o mesmo número e o
> baseline do braço antigo morre dentro da própria medição. Isso foi pego acontecendo — o braço
> do cache caiu de 21/24 · MRR 0,636 para exatamente o número do outro, o que **parece um achado
> e é um artefato**. Termômetro não pode mudar a temperatura.

> ⚠️ **Não leia esta tabela sem a composição do gabarito.** A maioria destas perguntas cai no regime
> em que uma busca textual já resolveria — o que infla qualquer número agregado. Os detalhes estão em
> [o que estes números **não** provam](#-o-que-estes-números-não-provam), e vale a pena ler antes de
> comparar com o seu.

### O gabarito de treino não basta — e a prova disso

As 24 perguntas acima são **treino**: elas e os ajustes que elas justificam nasceram juntos. Por isso
existe um segundo gabarito, **construído ao contrário de propósito** — o alvo é sorteado
mecanicamente (semente fixa) entre nós com docstring, e só **depois** a pergunta é escrita a partir
do que a função faz. Ele nunca foi usado pra ajustar nada.

**Ele reprovou a primeira versão desta melhoria.** BM25 clássico com token exato parecia ótimo no
treino (recall 20→**21**, MRR 0.653→**0.733** com `k1` afinado) e desabou no held-out (recall
**11/14** contra 12/14 do código antigo), com o `k1` afinado rendendo resultado **idêntico** ao
default — a afinação comprou zero.

A causa: o casamento por substring que a "correção" eliminou funcionava como um **radicalizador
cross-lingual acidental**. Quando a pergunta vem num idioma e os identificadores são ingleses, a
palavra da pergunta é com frequência **prefixo** do cognato (`portugues` ⊂ `portuguese`). Daí o
desenho final: BM25 com `k1`/`b` nos **defaults da literatura** e casamento **por prefixo**.

| | treino (24) | held-out (14) | nós/pergunta |
|---|---|---|---|
| substring (anterior) | MRR 0.653 | recall 12 · MRR 0.721 | 36.4 |
| BM25 token exato | MRR 0.691 | recall **11** · MRR 0.693 | 34.6 |
| **prefixo + BM25 (padrão)** | MRR **0.693** | recall 12 · MRR **0.764** | **34.6** |

A/B a qualquer momento: `CEREBRO_LEXICO=legado|bm25|prefixo`.

### 🔴 Correção: a coluna held-out acima foi medida com o motor amputado

A ponte de reescrita cross-language é 1 chamada a uma API free. A cota tinha estourado; o motor
degradou pro braço léxico e **avisou** (`rewrite=falhou`) — mas o harness não lia o aviso e
publicou o número como se fosse propriedade do motor. Reproduzido depois na vírgula, escondendo o
cache e a chave: `recall 12/14 · MRR 0.764 · 34.6 nós`, dígito por dígito.

Com a ponte viva, mesmo gabarito:

| léxico | held-out (ponte VIVA) | nós/pergunta |
|---|---|---|
| substring (legado) | recall **14/14** · hit@3 12/14 · MRR **0.885** | 39.1 |
| **prefixo + BM25 (padrão)** | recall **14/14** · hit@3 **13/14** · MRR 0.867 | 41.4 |

Duas consequências. A primeira é boa: **o motor é melhor do que estava publicado.** A segunda não:
**a escolha do léxico padrão foi feita com o motor amputado.** Amputado, `prefixo` ganhava com
folga; inteiro, os dois **empatam** — `legado` leva no MRR, `prefixo` no hit@3 e custa ~6% mais
nós. `prefixo` segue como padrão pelo treino (0.693 vs 0.653), mas por margem estreita.

> **A lição, que vale pra qualquer harness:** um componente opcional que cai sozinho transforma
> toda medição seguinte numa medição de outro motor. Se o seu retriever tem parte que pode
> degradar, **o medidor tem que se recusar a dar número** quando ela cai. Aqui a trava existia —
> em *outro* arquivo, posto no dia anterior. Defesa aplicada num lugar só é defesa que ainda não
> existe.

> **Se você for medir seu próprio retriever, roube isto e não o número:** um gabarito onde você
> ajustou parâmetros não mede mais o motor, mede o gabarito. Construa o segundo ao contrário
> (alvo primeiro, por sorteio; pergunta depois) e rode-o **uma vez por mudança**.

## ⚖️ O que estes números **não** provam

Um número agregado esconde **de que tipo** eram as perguntas. Seguindo o
[CodeCompass](https://arxiv.org/abs/2602.20048), que mede recuperação de código em três regimes,
classificamos cada pergunta **mecanicamente** — quem decide é o grafo, não o autor:

| | o alvo é… | quem já resolveria |
|---|---|---|
| **G1** | nomeado por um termo da própria pergunta | `grep` |
| **G2** | a ≤2 saltos de algo que a pergunta nomeia | travessia — **é aqui que o grafo deveria pagar** |
| **G3** | nem nomeado nem alcançável por travessia curta | só um índice semântico |

E o resultado é desconfortável:

| | composição | G1 | G2 | G3 |
|---|---|---|---|---|
| treino (24) | 71% G1 | 16/17 · MRR **0.843** | 2/2 · hit@3 **0/2** | 2/5 |
| held-out (14) | **86% G1** | 12/12 · MRR **0.892** | n=1 | n=1 |

**Ou seja: o `MRR 0.764` é, na prática, o número do G1** — o regime em que a busca por palavra já
funcionaria. O motor é muito bom nele. No regime que justificaria um grafo existir, ele é
**não-provado**, e em dois pontos por motivos diferentes:

- **G2 é um defeito de ORDENAÇÃO, não de recuperação.** Recall 2/2, hit@3 **0/2**: o motor **acha o
  alvo e o enterra no fim da lista**. A causa é conhecida — a distância no grafo só assume 3 valores,
  então dezenas de nós empatam e o desempate acaba sendo a ordem de inserção do BFS. *(Já tentamos
  desempatar por convergência, somando `1/(1+d)` sobre cada seed: piorou os dois gabaritos e custou
  +51% de token. Provavelmente porque premia o nó-hub, que é justamente o que o damping `sqrt(refs)`
  existe pra conter. Se essa for sua primeira ideia — foi a nossa, e não funcionou.)*

  **Atualização de 29/07/2026 — uma segunda causa, e esta era maior.** O peso de recência valia
  **×50** na escolha dos arquivos: qualquer arquivo tocado no git nos últimos 30 dias batia qualquer
  arquivo não tocado, independente de relevância. Flagrado numa pergunta real em que os *seeds*
  acertaram o símbolo-alvo (**rank 1 sem o boost**) e oito arquivos recém-editados passaram na
  frente — o alvo não entrou nem no top-8. Ou seja: parte do "acha e enterra" era este tempero, não
  o empate do BFS. Baixado pra **×3**, escolhido no gabarito cego (held-out 14/14, treino 20/24;
  `×1` ganhava no treino e **caía** no held-out).
  **O que ainda não medimos: se isso conserta o hit@3 do G2.** É plausível e não está verificado —
  o estrato G2 não foi re-rodado depois da mudança. Fica como hipótese aberta, não como conserto.
  O erro de origem vale mais que o número: a medição de 18/07 comparou *boost-no-nó × boost-no-arquivo*
  e escolheu o segundo. **Ninguém comparou boost × ausência de boost.** Toda heurística tem que
  vencer o baseline "sem ela".
- **G3 continua NÃO TESTADO — nem confirmado, nem refutado.** Um terceiro conjunto deu **1/3**, e
  este texto durante cinco dias chamou isso de *"resultado contra a aposta do projeto"*, somando com
  o `0/1` do G2 pra dizer que "três conjuntos independentes contam a mesma história". **Era
  autocontradição:** a seção logo abaixo explica que **8 das 12 perguntas daquele conjunto nem eram
  G3** — então ele não é um terceiro conjunto independente, e `1/3` sobre uma amostra
  desqualificada não é evidência de nada. Corrigido em 29/07/2026. O que sobra é honesto e menor:
  **ninguém mediu G3 ainda.** A linha de trabalho está arquivada por **custo**, não por refutação.

### E o conjunto "G3" nem era G3 — o que é um aviso pra quem for repetir isto

As 12 perguntas do terceiro conjunto foram mineradas do grafo procurando pares (A→T) ligados por
aresta e **sem nenhum token em comum**, na expectativa de produzir dependência escondida. O
classificador discordou: **8 das 12 são G1.** A mineração acertou o alvo em 3 de 12.

A falha é instrutiva: A e T não compartilharem vocabulário **não implica** que a *pergunta* não
compartilhe com T. A pergunta é escrita por uma pessoa descrevendo o consumidor, e ela reintroduz o
vocabulário do alvo por outro caminho. **Se você for construir um conjunto G3, classifique a pergunta
final — não o par de nós.** Caso contrário você mede G1 achando que mede G3.

> **A leitura honesta:** o que está demonstrado aqui é **economia de token** — a mesma resposta com
> uma fração do contexto, e isso se sustentou em toda medição (6.2x, acerto 20/24). **Superioridade
> sobre `grep` não está demonstrada** — e note que "não demonstrada" é diferente de "refutada", que é
> o que este parágrafo afirmava até 29/07/2026 ("a pouca evidência que existe aponta contra"). Só o
> G2 tem defeito medido e real; o conjunto de G3 era inválido. As amostras são pequenas e não decidem
> nada sozinhas, mas são as únicas que existem, e seria desonesto escondê-las atrás de um número
> agregado bonito — ou endurecê-las em veredito, que é o erro oposto e foi o que aconteceu aqui.
>
> Se você publicar números do seu retriever, publique a **composição** junto: sem ela, "MRR 0.76"
> pode significar coisas muito diferentes.

### E conte tool calls, não só tokens

Uma corrida real de agente (headless, transcript medido) expôs um custo que o nosso benchmark
**não enxergava**. Na pergunta mais difícil do conjunto, o motor acertou o alvo na **2ª chamada** —
e o agente gastou **mais 15 chamadas** de leitura e busca só para descobrir *onde o arquivo mora*.

Causa: a resposta trazia `src=` **relativo à raiz do projeto**, e quem consome não sabe qual é essa
raiz. Emitir a raiz e caminhos absolutos levou a mesma pergunta de **17 tool calls para 2**.

| | antes | depois |
|---|---|---|
| chamadas ao grafo | 1 | 1 |
| leitura/busca de arquivo | **15** | **0** |
| **total** | **17** | **2** |

> **Um índice que devolve um endereço que o leitor não consegue abrir cobra em tool call o que
> economizou em token.** Um benchmark que mede só o token do retorno nunca vê essa conta — a nossa
> métrica de 6.2x não via.

Se você mede retrieval para agente, meça **tool calls até a resposta**. É a unidade que o usuário
paga em latência, em contexto e em paciência.
