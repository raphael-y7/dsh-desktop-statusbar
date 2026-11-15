<h1 align="center">dsh-desktop-statusbar</h1>

<p align="center">
  <a href="https://github.com/raphael-y7/dsh-desktop-statusbar/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/raphael-y7/dsh-desktop-statusbar?style=flat&logo=github&color=f5f5f5"></a>
  <a href="https://www.npmjs.com/package/dsh-desktop-statusbar"><img alt="npm downloads" src="https://img.shields.io/npm/dt/dsh-desktop-statusbar?style=flat&logo=npm&label=downloads&color=e74c3c"></a>
  <a href="https://www.npmjs.com/package/dsh-desktop-statusbar"><img alt="npm version" src="https://img.shields.io/npm/v/dsh-desktop-statusbar?style=flat&color=9B59B6"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="DeepSeek Harness" src="https://img.shields.io/github/v/tag/deepseek-ai/deepseek-harness?label=DeepSeek%20Harness&color=4d6bfe"></a>
  <a href="https://awesome-dsh-plugin.com/p/raphael-y7/dsh-desktop-statusbar/"><img alt="dshmarket" src="https://img.shields.io/badge/dshmarket-listed-%23e6b800?style=flat"></a>
  <a href="https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar"><img alt="dshfind" src="https://img.shields.io/badge/dshfind-listed-%2300897B?style=flat"></a>
  <a href="https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar"><img alt="1024Store" src="https://img.shields.io/badge/1024Store-listed-%23e67e22?style=flat"></a>
  <br>
  <a href="https://nodejs.org/"><img alt="node" src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-%230099cc?style=flat"></a>
  <img alt="language" src="https://img.shields.io/badge/javascript-100%25-%23ec407a?style=flat">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-%2327ae60?style=flat"></a>
</p>

<p align="center"><a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.es.md">Español</a> | <a href="README.fr.md">Français</a> | <a href="README.de.md">Deutsch</a> | <a href="README.ru.md">Русский</a> | <a href="README.pt.md">Português</a></p>

Substitui a linha de estatísticas sob a entrada de mensagem no aplicativo desktop DSH por uma barra de status configurável: campos, ordem, preços por modelo e moeda são todos configuráveis, com estimativas de custo em tempo real usando as tarifas oficiais de pico/fora de pico da DeepSeek.

<video src="https://github.com/user-attachments/assets/5a4f7fd8-a445-490d-a557-1ec840c611df" controls muted playsinline width="720"></video>

## Recursos

- **9 campos opcionais mais o anel de contexto**: ocupação do contexto (o anel no início da barra), verificação de pico/fora de pico, turnos e etapas, taxa de acerto de cache, velocidade de saída, TTFT, tempo de execução, custo deste turno, custo da sessão, saldo
- **Clique em um campo para ver detalhes**:

  | Campo | Conteúdo |
  | --- | --- |
  | Anel de contexto (início da barra) | Prompt do sistema / definições de ferramentas / mensagens |
  | Verificação de pico/fora de pico | Mapa de calor de uso: dia / semana / mês / ano |
  | Turnos e etapas | Compactações de contexto / habilidades injetadas / chamadas de ferramentas |
  | Acerto combinado | Este turno / maior / menor taxa de acerto de cache |
  | TPS | Este turno / velocidade mais rápida / mais lenta |
  | TTFT | Este turno / menor / maior atraso até o primeiro token |
  | Tempo de execução | Tempo de espera / tempo do modelo / chamadas de ferramentas |
  | Custo deste turno | Detalhamento de tokens deste turno |
  | Custo da sessão | Detalhamento cumulativo de tokens desta sessão |
  | Saldo | Saldo recarregado / saldo concedido / cota restante |

- **Detalhamento dos dados da sessão**: as compactações de contexto marcam o nó em que ocorreram, “habilidades injetadas” conta as habilidades injetadas nesta sessão, e as chamadas de ferramentas listam cada ferramenta usada pela sessão com sua contagem de chamadas; clique no título para voltar
- **Verificação de versão e atualização**: o DSH verifica a versão mais recente na inicialização, mostra uma dica ao lado do item de navegação “Barra de status” quando uma está disponível, e oferece um botão de atualização com um clique nas configurações
- **Suporte no GitHub**: o botão abre a página do projeto no GitHub, onde você pode dar uma estrela ao projeto.
- **Estimativa de custo**: precificado com as regras oficiais de pico/fora de pico; cada chamada é calculada a partir do momento em que ocorreu e do modelo que usou
- **Tabela de preços**: seus próprios preços, uma divisão opcional de pico/fora de pico e um alternador de moeda CNY / USD
- **Além disso**: atualizações automáticas de feriados, saldo atualizado a cada minuto, 8 idiomas de interface (简体中文 / English / 日本語 / Español / Français / Deutsch / Русский / Português)

## Instalação

No aplicativo desktop DSH, abra **Plugins → Adicionar plugin** e instale pelo nome do pacote:

```
dsh-desktop-statusbar
```

Onde o registro npm não estiver acessível, o mesmo diálogo oferece o espelho da China continental como fonte de instalação. Uma URL de repositório do GitHub também é aceita:

```
https://github.com/raphael-y7/dsh-desktop-statusbar
```

Linha de comando:

```powershell
dsh plugin --profile desktop add dsh-desktop-statusbar
```

### Instalar a partir do npm

Ambas as formas acima instalam a partir do registro npm; o nome do pacote é `dsh-desktop-statusbar`. Para verificar a versão atual no npm:

```powershell
npm view dsh-desktop-statusbar version
```

### Quando o atualizador integrado falha

O botão integrado de atualização com um clique pode falhar em algumas compilações desktop, seja não respondendo ou relatando um erro. Nesse caso, use a entrada oficial de instalação e **acrescente `@version` ao nome do pacote** para instalar a versão exata:

```powershell
dsh plugin --profile desktop add dsh-desktop-statusbar@3.0.5
```

A mesma string funciona no painel de plugins: digite `dsh-desktop-statusbar@3.0.5` no campo **Adicionar plugin**.

Use a versão mais recente atual (mostrada na página de release ou na saída do `npm view` acima). Fixar a versão também garante que **você instale exatamente a compilação desejada**, evitando um pacote em cache desatualizado.

Também listado em [dshmarket](https://awesome-dsh-plugin.com/p/raphael-y7/dsh-desktop-statusbar/), [dshfind](https://dshfind.com/zh/plugins/raphael-y7/dsh-desktop-statusbar) e [1024Store](https://deepseek1024.com/plugins/Rapheal-Y7/dsh-desktop-statusbar).

## Uso

Abra **Configurações → Barra de status**:

![Settings page](docs/settings.en.png)

- **Ocupação do contexto**: o anel no início da barra — o progresso mostra a parcela do contexto usada, a lacuna marca o limite de compactação e a cor mostra o estado de execução (ocioso-cinza / em execução-verde / subagente em execução-azul / subagente mais profundo em execução-violeta / erro-vermelho / aguardando aprovação-âmbar)
- **Campos de estatísticas**: marcar controla apenas a visibilidade, então desmarcar oculta um campo sem movê-lo; arraste a alça à direita para reordenar; “Redefinir configurações” restaura a ordem de fábrica
- **Preços personalizados de modelos**: insira um nome de modelo e “Adicionar” para criar uma entrada; “Editar” abre o editor e as alterações são gravadas ao salvar; marque “preços de pico/fora de pico” para dividir por hora do dia, caso contrário aplica-se um preço único o dia todo
- **Moeda**: CNY ou USD no canto superior direito do editor. Alternar substitui os dois modelos integrados pelos preços de referência oficiais dessa moeda (as entradas editadas são mantidas) e altera o símbolo nos campos de custo; o saldo segue a moeda informada pela API
- **Feriados**: obtém e grava automaticamente o calendário do próximo ano após 31 de dezembro de cada ano
- **Saldo**: atualizado uma vez por minuto

### Regras de cobrança

Os horários de pico são **09:00–12:00 e 14:00–18:00 no horário de Pequim, de segunda a sexta-feira**, e as tarifas fora de pico são metade das tarifas de pico; feriados públicos chineses e fins de semana são cobrados fora de pico o dia todo (de acordo com a [documentação oficial](https://api-docs.deepseek.com/quick_start/pricing), verificada em 2026-09).

![Custom model prices](docs/pricing.en.png)

## Consulta de saldo do relay

Ao consultar um saldo, a barra de status escolhe o método de consulta com base **na plataforma realmente usada pela sessão atual**, em dois casos: correspondência automática e configuração manual.

### 1. Correspondência automática

Quando o relay está configurado como um provider comum na página **Modelos** do DSH (com baseURL e chave de API), o plugin usa essa chave para sondar em paralelo os seguintes endpoints de saldo comuns; se qualquer endpoint analisável responder, o saldo é exibido sem configuração adicional:

- `/v1/usage`
- `/v1/user/self`, `/api/user/self`, `/api/v1/user/self`
- `/api/usage`
- `/v1/dashboard/billing/credit_grants`
- `/v1/credits`

Se o endpoint de saldo do site seguir uma das formas padrão acima e puder ser lido com `Authorization: Bearer <chave de API>`, o saldo é exibido automaticamente.

### 2. Configuração manual

Em qualquer um dos casos a seguir, você deve adicionar uma entrada de plataforma em **Configurações → Barra de status → Preços personalizados de modelos → Plataforma** e preencher o endpoint e as credenciais:

- o provider não tem baseURL configurada na página **Modelos**;
- o endpoint de saldo ou o esquema de autenticação não segue uma forma padrão (por exemplo, o New API exige um cabeçalho de requisição extra com o ID do usuário);
- a estrutura de resposta do endpoint não pode ser analisada automaticamente.

Os campos são definidos da seguinte forma:

| Campo | Descrição | Exemplo |
| --- | --- | --- |
| Cabeçalho de requisição | Nome do cabeçalho de requisição usado para o ID do usuário; a autenticação por token sempre usa `authorization: Bearer` e não precisa ser preenchida | `New-Api-User` |
| ID do usuário | O identificador de usuário para o cabeçalho de requisição acima | `12345` |
| Token | New API: insira o “token de acesso” (o token de acesso do sistema nas configurações pessoais); Sub2API: insira o “token de login”; relay comum: insira a chave `sk-` usada para chamar modelos | `sk-...` |
| Endereço de consulta de saldo | URL completa do endpoint de saldo | `https://example.com/api/user/self` |
| Campo de saldo | Símbolo da moeda, caminho do campo e divisor, no formato `<moeda><caminho do campo> / <divisor>` | `$data.quota / 500000` |
| Modelos aplicáveis | Modelos pertencentes a esta plataforma | — |
| Multiplicador de custo | Multiplicador de precificação, padrão 1 | `1` |

#### Exemplo 1: site compatível com New API

- Endereço de consulta de saldo: `https://example.com/api/user/self`
- Campo de saldo: `$data.quota / 500000` (este site considera 500000 de cota como 1 yuan)
- Token: o token de acesso gerado nas configurações pessoais (não a chave de chamada de modelos)
- Cabeçalho de requisição: `New-Api-User`; ID do usuário: o ID de usuário da conta

#### Exemplo 2: site Sub2API

O endpoint de saldo de sites Sub2API costuma ter uma das duas formas a seguir; escolha conforme a situação real do site:

- Suporta `GET /v1/usage` compatível com OpenAI (autenticação com a chave de modelo `sk-`): geralmente é correspondido automaticamente, sem configuração manual; se não for correspondido, defina o token como essa chave `sk-` e o endereço de consulta de saldo como `https://example.com/v1/usage`.
- Apenas o endpoint de console está disponível (o endpoint fica em `/api/v1/*` e exige sessão de login no console): defina o endereço de consulta de saldo como o endpoint de saldo do console do site (conforme o real do site) e **defina o token como o “token de login”** (a credencial de acesso obtida após o login no console, não a chave de chamada de modelos); preencha o campo de saldo conforme a estrutura de resposta do endpoint.

#### Exemplo 3: relay compatível com OpenAI com chave única

- Token: a chave `sk-` usada para chamar modelos
- Geralmente é correspondido automaticamente; se não for, adicione o endereço de consulta de saldo e o campo de saldo (como `$balance` ou `$data.balance`).

> Nota: se o endereço de consulta de saldo ficar vazio, o saldo dessa plataforma não é consultado, mas ela ainda participa da cobrança pelo multiplicador de custo.

## Limitações conhecidas

- TTFT e velocidade mais rápidos / mais lentos vêm de uma nova projeção no lado do host: **você deve fechar e reiniciar completamente o DSH** antes que ela comece a coletar
- Um modelo sem preço não é cobrado; adicionar o preço preenche retroativamente suas chamadas anteriores
- A atualização com um clique depende de `pnpm`: o aplicativo desktop usa a cópia incluída com o host, enquanto o uso via CLI / web precisa de `pnpm` no sistema. Se nenhum for encontrado, a atualização diz isso explicitamente **e registra cada local que tentou**; você também pode apontá-la para um comando específico com a variável de ambiente `DSH_DESKTOP_STATUSBAR_PNPM`

## Permissões e acesso externo

O plugin lê logs de sessão e configuração local para calcular uso, saldo e custo, e oferece suporte a autoatualização com um clique, portanto é um **plugin de alto privilégio**. Abaixo está o limite real de permissões (correspondente ao código em `lib/`). Revise-o antes de instalar.

### Arquivos

| Caminho | Finalidade | Notas |
| --- | --- | --- |
| `<DSH_HOME>/dsh-status-bar/usage-ledger.json` | Registro de uso local, preenchido a partir do histórico na inicialização | Grava apenas dentro do próprio diretório do plugin |
| `<DSH_HOME>/dsh-status-bar/holidays.json` | Cache de feriados públicos | Gravado durante as atualizações automáticas de feriados em segundo plano |
| `<DSH_HOME>/dsh-status-bar/exchange-rate.json` | Cache diário de taxas de câmbio | Gravado ao atualizar as taxas de câmbio em segundo plano |
| `<DSH_HOME>/dsh-status-bar/tip-diag.log` | Log de diagnóstico | Registra diagnósticos de posição das dicas para ajudar na solução de problemas |
| `<DSH_HOME>/dsh-status-bar/relay-balance.json` | Configuração de saldo de relay (sem segredo em texto simples) | Diretório do plugin |
| `<DSH_HOME>/sessions` | Lê logs de sessão para calcular estatísticas de tokens / custo | Somente leitura |
| `<DSH_HOME>/.credentials.yaml` | Lê chaves de API apenas por refs quando nem o serviço de credenciais nem as variáveis de ambiente fornecem uma | Somente leitura |
| Perfil `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` | Faz backup e regrava durante a autoatualização com um clique | Apenas quando você clica em “atualização com um clique” |

### Rede

As requisições são feitas apenas para mostrar saldo, taxas de câmbio, feriados ou verificar atualizações; todas por HTTPS, exceto o loopback local 127.0.0.1, e falham silenciosamente no tempo limite sem bloquear os outros campos da barra de status.

| Domínio | Finalidade |
| --- | --- |
| `api.deepseek.com` | Saldo da conta DeepSeek |
| `openrouter.ai` | Créditos OpenRouter |
| `api.siliconflow.com` / `api.siliconflow.cn` | Informações da conta SiliconFlow |
| `api.moonshot.ai` / `api.moonshot.cn` | Saldo Moonshot |
| `open.bigmodel.cn` / `api.z.ai` | Cota Zhipu |
| `api.b.ai` | Saldo B.AI |
| `api.xiaomimimo.com` | Saldo Xiaomi MiMo |
| `api.stepfun.com` / `api.stepfun.ai` | Saldo da conta StepFun (China / Internacional) |
| `www.minimax.cn` | Cota MiniMax Token Plan |
| `management-api.x.ai` | Saldo da equipe xAI |
| `business.aliyuncs.com` | Saldo da conta BSS Alibaba Cloud |
| `open.er-api.com` | Taxa de câmbio CNY |
| `sousuo.www.gov.cn` | Atualização automática de feriados públicos |
| `registry.npmjs.org` | Verificação de versão (autoatualização) |
| `127.0.0.1` (loopback) | Porta web do host / adaptadores locais |

Deixar a URL de saldo de uma plataforma vazia significa que ela não é consultada, e isso não afeta a cobrança.

### Credenciais

- Usa primeiro o serviço de credenciais do host `ctx.credentials` (a fonte autoritativa gravada pela página de modelos); se indisponível, recorre a variáveis de ambiente (por exemplo, `DEEPSEEK_API_KEY` e o nome de refs de cada adaptador), depois à seção de refs de `<DSH_HOME>/.credentials.yaml`.
- As chaves de API são **usadas apenas para consultar o saldo dessa plataforma**; nunca são enviadas para outro lugar, registradas em log ou gravadas no ledger.
- A página de configurações mostra os tokens como pontos com seleção para copiar; `GET /dsh-desktop-statusbar/api/relay-balance-config` retorna o token de mesma origem para o frontend. Esse endpoint é apenas loopback (verificações de Host / Origin / remoteAddress) e nunca sai da máquina.

### Comandos

- `pnpm` é invocado apenas quando você clica em “atualização com um clique”: ele prefere o pnpm incluído com o host (por exemplo, `runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs`), recorrendo ao `pnpm` do sistema; você pode apontá-lo com a variável de ambiente `DSH_DESKTOP_STATUSBAR_PNPM`.
- Em caso de falha, a atualização restaura o backup do Perfil e mostra o motivo; se o pnpm não for encontrado, ele relata explicitamente e registra cada local tentado.

### Limites de falha

- Sem credenciais: o saldo dessa plataforma mostra “—”; os outros campos continuam funcionando.
- Falha de rede / tempo limite: apenas esse saldo ou taxa é afetado; as outras estatísticas não são afetadas.
- pnpm não encontrado: a atualização com um clique emite erro explicitamente em vez de falhar silenciosamente.
- Falha de autoatualização: o backup de `package.json` / arquivo de bloqueio do Perfil é restaurado.

### Riscos conhecidos

- Plugin de alto privilégio (leitura/escrita de arquivos + rede + credenciais + comandos) — decida se deseja instalá-lo após compreender o escopo das permissões.
- Quando os serviços externos de saldo estão indisponíveis, os números relacionados ficam ausentes ou desatualizados.
- A autoatualização com um clique precisa de acesso de gravação ao diretório do Perfil.

## Desenvolvimento

Cada teste é um script autônomo destinado a ser executado com node puro — sem framework de testes.

```powershell
npm test          # runs every verify*.js/.mjs under tests/, then checks project vs installed plugin dir
npm run sync      # copies lib/ into the installed plugin dir
```

Os scripts de desenvolvimento em `tools/` são distribuídos com o pacote (o campo `files` os inclui),
então tanto um clone do git quanto uma instalação via npm os obtêm:

| Script | Finalidade |
|---|---|
| `tools/test.cjs` | execução completa de testes + verificação de consistência |
| `tools/sync-to-plugin.cjs` | `lib/` do projeto → diretório do plugin instalado |
| `tools/sync-from-plugin.cjs` | diretório do plugin instalado → `lib/` do projeto |
| `tools/plugin-dir.cjs` | localiza o diretório do plugin |
| `tools/shot.cjs` | regenera as capturas de tela do README |

Eles são usados apenas durante o desenvolvimento; o plugin nunca os carrega em tempo de execução.
O pacote npm inclui `tests/` e `tools/`, então uma cópia instalada pode executar `node tools/test.cjs`
diretamente (execução completa de testes + verificação de consistência).

O diretório do plugin é localizado automaticamente: variável de ambiente `DSH_STATUS_BAR_PLUGIN_DIR` →
layouts conhecidos em `~/.dsh` (`local-plugins/`, cada `profiles/*/node_modules/`) → derivado da localização de
`tools/`. Nenhuma alteração de código é necessária ao trocar de máquina ou nome de usuário.

## Licença

[MIT](LICENSE): livre para usar, modificar e redistribuir; mantenha o aviso de direitos autorais e licença.