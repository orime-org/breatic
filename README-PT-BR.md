<h1 align="center">Breatic</h1>

<p align="center"><strong>O espaço de trabalho colaborativo com IA, em tempo real, para equipes criativas.</strong></p>
<p align="center">Disponível on-line · Código disponível · Navegador de desktop</p>

<p align="center">
  <a href="https://breatic.ai/?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_website_pt_br">Site</a> ·
  <a href="https://breatic.ai/login?utm_source=github&amp;utm_medium=referral&amp;utm_campaign=repository_listing_202610&amp;utm_content=readme_pt_br">Experimentar Breatic</a> ·
  <a href="https://youtu.be/mc1XAqtJD_M">Demo de 45 s (inglês)</a> ·
  <a href="docs/USAGE.md">Guia (inglês)</a> ·
  <a href="https://discord.gg/Yeu6A4aejN">Discord</a>
</p>

<p align="center">
  <a href="https://github.com/orime-org/breatic/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/orime-org/breatic?style=flat&amp;color=blueviolet&amp;label=release&amp;display_name=tag"></a>
  <a href="LICENSE"><img alt="License: Elastic-2.0" src="https://img.shields.io/badge/license-Elastic--2.0-blue?style=flat"></a>
  <a href="https://discord.gg/Yeu6A4aejN"><img alt="Discord community" src="https://img.shields.io/badge/discord-join%20community-5865F2?style=flat&amp;logo=discord&amp;logoColor=white"></a>
  <a href="#get-started"><img alt="Quickstart guide" src="https://img.shields.io/badge/quickstart-guide-green?style=flat"></a>
</p>

<p align="center" dir="ltr">
  <a href="README.md">English</a> · <a href="README-CN.md">简体中文</a> · <a href="README-TW.md">繁體中文</a> · <a href="README-JA.md">日本語</a> · <a href="README-KO.md">한국어</a> · <a href="README-ES.md">Español</a> · <strong>Português</strong><br>
  <a href="README-DE.md">Deutsch</a> · <a href="README-FR.md">Français</a> · <a href="README-AR.md">العربية</a> · <a href="README-RU.md">Русский</a> · <a href="README-UK.md">Українська</a> · <a href="README-TR.md">Türkçe</a> · <a href="README-TH.md">ภาษาไทย</a>
</p>

---

Reúna o briefing, as cenas e os arquivos de mídia em um só Project. Escreva em Document Spaces, gere e refine recursos em Canvas Spaces e trabalhe com um agente de IA e colaboradores mantendo o contexto da produção.

O serviço hospedado oferece o plano Starter gratuito. Os créditos de geração com IA são comprados separadamente e não estão incluídos nas assinaturas. Veja [preços e créditos][hosted-pricing].

![Imagens de uma cafeteria no canvas do Breatic ao lado do chat do projeto; interface em inglês](docs/images/readme/workspace-en.png)

## O que você pode fazer

| Recurso | Para que serve |
| --- | --- |
| **Projects com vários Spaces** | Organize briefing, cenas e alternativas criativas em abas separadas. |
| **Document Spaces** | Escreva roteiros, descrições de tomadas e listas de produção com texto formatado. |
| **Canvas Spaces** | Organize referências e mídia em um canvas infinito; gere e refine recursos com prompts, modelos e referências. |
| **3D (DEV)** | Posicione objetos integrados em uma cena compartilhada e edite posição, rotação e escala. |
| **Timeline (DEV)** | Organize vídeos do Project ou vídeos locais enviados em faixas compartilhadas: mova, recorte, divida, duplique e exclua clipes, desfaça suas próprias edições e visualize a sequência. Descreva uma Web Animation, peça ao DeepSeek para criá-la, acompanhe-a na lista de execuções e adicione o resultado como clipes que tocam no relógio da Timeline. Vídeos e Web Animations de todas as faixas tocam juntos como camadas sobrepostas; selecione uma camada na prévia para movê-la, redimensioná-la, esticá-la ou girá-la, ou digite sua posição e tamanho. Escolha a proporção do quadro entre sete opções (16:9, 9:16, 1:1, 4:3, 4:5, 2:3, 21:9) no fim da barra de reprodução; as camadas mantêm seu lugar no quadro. |
| **Agente de IA no projeto** | Discuta ideias, forneça contexto de documentos ou do canvas e avalie propostas junto aos seus materiais. |
| **Colaboração em tempo real** | Convide colaboradores, defina permissões e trabalhe em canvases, documentos, cenas 3D e Timelines sincronizados. |

Os recursos podem ser imagens, vídeos, áudio e arquivos 3D. A geração depende dos provedores configurados e do acesso aos modelos. Canvas e Document estão disponíveis; 3D e Timeline têm a indicação **DEV**. A Timeline atual permite editar e visualizar vídeos e Web Animations em várias faixas visuais; Web Animation só está disponível nas implantações que a ativam. Outros tipos de mídia e a exportação de vídeo estão planejados. A geração por modelos e as anotações dentro da cena 3D estão em desenvolvimento.

## Avaliem as alterações juntos

Mantenha as decisões ao lado do trabalho. Um colaborador pode editar a direção compartilhada enquanto a equipe compara duas imagens de cena. O agente pode propor uma reescrita antes de substituir um trecho do documento: a equipe decide o que manter.

![Direção compartilhada junto a duas imagens de cena; interface em inglês](docs/images/readme/shared-direction.png)

![Proposta de reescrita com ações para comentar ou substituir; interface em inglês](docs/images/readme/agent-review.png)

As capturas vêm de um projeto de exemplo real; a história e os recursos ilustram o funcionamento.

## Um fluxo criativo: vídeo de uma cafeteria de 30 segundos

Um **Studio** reúne projetos e recursos. Um **Project** organiza uma produção; seus **Spaces** dividem o trabalho por cena, entrega ou direção criativa.

1. **Escreva o briefing** em um Document Space: história, público, diálogo e direção visual.
2. **Trabalhe com o agente:** leve o contexto relevante ao chat, discuta as tomadas e avalie as propostas.
3. **Desenvolva cada cena** em um Canvas Space: escolha um modelo configurado, adicione prompts e referências e compare variações.
4. **Revise e entregue:** selecione os recursos com seus colaboradores e baixe-os para a produção.

Você pode nomear Spaces como “Abertura · 0–10 s”, “Cena principal · 10–20 s” e “Encerramento · 20–30 s”. Esses nomes ajudam no planejamento; não definem a duração dos clipes nem montam um vídeo automaticamente. Use a Timeline para organizar e visualizar vídeos e seu editor de vídeo para finalizar e exportar. Veja o [exemplo ilustrado (inglês)](docs/USAGE.md#example-from-a-brief-to-a-visual).

<a id="get-started"></a>

## Comece a usar

- **Serviço hospedado:** [abra o Breatic][hosted-app] em um navegador de desktop e cadastre-se ou entre.
- **Instalação própria:** siga o [guia de instalação pessoal e em rede local (inglês)](self-host/LOCAL.md).
- **Desenvolvimento:** veja a [configuração do ambiente (inglês)](self-host/DEVELOPMENT.md).

Configure seu Studio pessoal, crie um Project e use **+** para adicionar Document, Canvas, 3D ou Timeline Spaces. Comece com um briefing, envie referências ou posicione objetos 3D integrados. O [guia de uso (inglês)](docs/USAGE.md) inclui os [atalhos de teclado](docs/USAGE.md#keyboard-shortcuts).

### Antes de hospedar por conta própria

A instalação usa imagens Docker publicadas para web, API, tarefas em segundo plano e colaboração, com PostgreSQL e Redis. Os envios e o processamento de mídia usam um Ingest Worker e um contêiner de mídia na **sua conta Cloudflare**, com armazenamento no seu bucket R2. As chamadas de IA usam suas contas de provedores e cotas.

Não é uma instalação off-line nem totalmente local. O acesso pela LAN exige HTTPS confiável. Serviços de nuvem e chamadas a modelos podem gerar custos; SMTP, login com Google, pagamentos Stripe e busca são integrações opcionais. Siga o guia para configurar e verificar a nuvem. A etapa inicial com Node/pnpm/Wrangler é de implantação, não um servidor de desenvolvimento necessário no uso diário.

## Status, ajuda e contribuições

O serviço hospedado está disponível e o desenvolvimento continua; as indicações DEV e os limites acima continuam válidos. Consulte as [versões publicadas](https://github.com/orime-org/breatic/releases).

[Relatar um problema](https://github.com/orime-org/breatic/issues/new?template=bug_report.yml) · [Sugerir um recurso](https://github.com/orime-org/breatic/issues/new?template=feature_request.yml) · [Discord](https://discord.gg/Yeu6A4aejN)

Para vulnerabilidades, use o canal privado de [SECURITY.md](SECURITY.md). O projeto usa TypeScript, React/Vite, Hono, PostgreSQL, Redis/BullMQ e Hocuspocus/Yjs, além de um Cloudflare Worker para uploads.

[Contribuir](CONTRIBUTING.md) · [Arquitetura](docs/ARCHITECTURE.md) · [Testes](docs/TEST-MANDATE.md)

[Site](https://breatic.ai) · [X](https://x.com/breatic_ai) · [YouTube](https://www.youtube.com/@breatic_ai) · [Instagram](https://www.instagram.com/breatic_ai)

## Licença e usos permitidos

O código-fonte do Breatic está disponível sob a [Elastic License 2.0](LICENSE) (Elastic-2.0). Você pode ler, modificar, redistribuir e executar o Breatic para si ou dentro da sua organização, inclusive em trabalhos comerciais. Não pode oferecer o Breatic a terceiros como serviço hospedado ou gerenciado. Consulte os termos completos na licença.

O nome e o logotipo são marcas da Orime, Inc. e não estão cobertos pela licença; veja [TRADEMARKS.md](TRADEMARKS.md). A licença não restringe o conteúdo que você cria com o Breatic.

### Conteúdo gerado

Operadores e usuários de cada instância são responsáveis por cumprir as leis aplicáveis — incluindo direitos autorais, marcas, privacidade, proteção de dados, difamação e moderação —, ter os direitos necessários sobre as entradas e os usos posteriores e moderar o conteúdo no seu contexto. A Orime, Inc. não garante a precisão, legalidade, originalidade ou segurança do conteúdo gerado.

Os componentes de terceiros e seus avisos estão em [THIRD-PARTY.md](THIRD-PARTY.md).

[hosted-app]: https://breatic.ai/login?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_pt_br
[hosted-pricing]: https://breatic.ai/pricing/?utm_source=github&utm_medium=referral&utm_campaign=repository_listing_202610&utm_content=readme_pricing_pt_br

© 2026 Orime, Inc.
