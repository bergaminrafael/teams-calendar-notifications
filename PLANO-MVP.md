# MVP — Teams Calendar Notification para GNOME

## Objetivo

Evitar perder reuniões exibindo um indicador permanente na barra superior do GNOME e um alerta persistente quando um compromisso do calendário começar.

O horário do calendário é a fonte de verdade deste MVP. “Em andamento” significa que o horário atual está entre início e término do evento; não significa que alguém entrou na chamada. A interface deve dizer “No horário da reunião” ou “Começou há X min”, sem afirmar que há participantes conectados.

## Contexto confirmado

- Ambiente do usuário: Ubuntu 26.04, GNOME 50.
- Teams for Linux 2.22.0, instalado por `.deb`.
- Reuniões aparecem normalmente no calendário do Teams for Linux e no Outlook web.
- **A organização bloqueia o acesso do aplicativo GNOME à conta Microsoft 365.** O caminho por Contas Online do GNOME está descartado para esta conta enquanto essa política não mudar. Não repetir essa configuração como etapa de implementação.
- A consulta Graph/MQTT do Teams for Linux ainda não foi testada; o login web funcionando não demonstra autorização dessa consulta.
- A aparente notificação com conteúdo antigo observada numa captura era o aviso do GNOME `“<título da janela>” is ready`. O título incluía a página Calendar e um nome, sem identificar necessariamente o remetente de uma mensagem.
- Foi recomendado testar a configuração abaixo; o usuário ainda não confirmou seu efeito:

```json
{
  "notificationMethod": "electron",
  "disableNotificationWindowFlash": true,
  "notifications": { "timeoutType": "never" }
}
```

Essa configuração reduz um problema separado de notificações. Não é pré-requisito para calcular lembretes de calendário.

## Decisão de produto

Validar primeiro uma fonte de calendário acessível pelas permissões existentes. O candidato é a integração documentada do Teams for Linux. Depois avaliar uma interface existente; criar uma extensão pequena apenas se a adaptação não atender ao escopo com menos trabalho e manutenção.

A arquitetura MQTT abaixo é uma proposta condicionada à validação, não uma decisão já comprovada. A sincronização depende do Teams for Linux aberto e autenticado; o cache local não substitui uma fonte atualizada.

A primeira etapa é uma prova de viabilidade, não a construção da interface. Ver o calendário no aplicativo não comprova que a consulta Graph integrada esteja autorizada ou funcional nessa conta.

## Alternativas pesquisadas e reaproveitamento

Pesquisa em 28/09/2026, baseada em documentação pública; nenhum candidato foi instalado ou testado nesta máquina.

| Candidato | Recursos documentados | Limites e decisão para este MVP |
| --- | --- | --- |
| Aurora Shell / Meeting Clock | Eventos junto ao relógio, alertas, adiamento e antecedência configurável; versões publicadas para GNOME 50 | Candidato mais próximo da interface desejada. Verificar persistência, eventos em andamento e fonte de dados na versão publicada. É um pacote de módulos, muitos habilitados por padrão; um teste deve habilitar apenas os necessários. |
| Evolution / Evolution Data Server | Janela de lembretes, opção de exibição imediata e solicitação para ficar acima das outras janelas | Precisa de calendário sincronizado. O acesso da conta via GNOME está bloqueado; não presumir que autenticar pelo Evolution será permitido. A solicitação de ficar por cima pode não ser respeitada no Wayland. |
| Calendar Reminders | GNOME 50; notificações com abrir calendário, entrar por link e adiar | Usa o mecanismo de lembretes do Evolution Data Server e substitui sua janela por notificações comuns. Não comprova persistência visual. O adiamento documentado não sobrevive a logout/desativação. Possível referência para ações e links. |
| Dim Completed Calendar Events | GNOME 50; destaca eventos em andamento no menu de calendário | Não oferece indicador sempre visível nem popup persistente por si só. |
| Next Up | Próximo evento na barra | Suporte publicado encontrado até GNOME 47; não forçar compatibilidade com 50. |
| GNOME Next Meeting Applet | Contagem até reunião e atalhos | Arquivado em outubro de 2024; referência, não primeira opção para instalar. |
| Eventix | Calendário Linux, alarmes, Microsoft 365 via DavMail | Persistência equivalente não confirmada; outro cliente também depende de autorização. Não adotar como forma de contornar o bloqueio. |

O GNOME adicionou calendário Microsoft 365 às Contas Online na versão 47, mas esse recurso não está disponível para esta conta devido à política informada. Extensões que exibem a agenda local não resolvem sozinhas a autenticação ou a sincronização.

### Etapa 0B — Escolher a interface após validar a fonte

1. Examinar o módulo de calendário do Aurora na versão compatível com GNOME 50: a documentação consultada usa `Meeting Clock`, enquanto o README da branch principal também menciona `Calendar Reminders`. Confirmar nome e comportamento na versão selecionada.
2. Verificar se ele recebe dados de uma interface utilizável ou se exige uma agenda no Evolution Data Server. Não presumir suporte a MQTT ou ao snapshot JSON proposto neste plano.
3. Se a adaptação da fonte e do comportamento for pequena, reaproveitar o projeto respeitando licença e atribuição. Registrar o que será alterado e como manter atualizações.
4. Se isso exigir manter um fork amplo, sincronizar calendários adicionais ou importar vários módulos sem utilidade, preferir a extensão pequena prevista no plano. Não criar um calendário intermediário no Evolution apenas para encaixar a interface sem avaliar o custo.
5. Preservar os critérios do MVP: indicador de evento decorrendo, alerta realmente visível, dispensa por ocorrência e retomada após suspensão. Uma notificação no histórico não satisfaz persistência visual.

## Escopo visual

| Situação | Indicador na barra | Alerta |
| --- | --- | --- |
| Sem reunião próxima | Ícone discreto de calendário | Nenhum |
| Até 5 min antes | `Reunião em 5 min` | Nenhum no MVP |
| Chegou o início | `Reunião · começou há 1 min` | Cartão persistente |
| Usuário confirmou uma ação | Indicador discreto até o fim | Fecha o cartão |
| Horário de término | Próxima reunião ou ícone discreto | Fecha o cartão daquela ocorrência |
| Agenda desatualizada | Indicador de sincronização pendente | Sem avisos repetitivos de erro |

Cartão proposto:

```text
📅 Daily da equipe
17:00–17:30 · começou há 3 minutos

[ Entrar ]   [ Adiar 2 min ]   [ Dispensar ]
```

- **Entrar:** abre o link disponível pelo mecanismo padrão do desktop. Confirmada a abertura, silencia o alerta daquela ocorrência. Isso não comprova que o usuário entrou na chamada.
- **Adiar 2 min:** fecha o cartão e agenda uma nova exibição, apenas enquanto o evento não terminou.
- **Dispensar:** silencia essa ocorrência até o fim; mantém acesso pelo indicador.
- Sem link: mostrar `Abrir Teams` ou omitir `Entrar`, sem inventar URL.
- Clicar no indicador abre a lista de eventos próximos/atuais e permite reabrir o cartão dispensado.
- Títulos longos devem ser truncados na barra e legíveis no cartão.
- Não depender apenas de cor; incluir texto/ícone e suporte a teclado.
- O cartão não deve bloquear o teclado ou roubar foco enquanto o usuário trabalha.
- MVP sem som repetitivo; persistência visual é o mecanismo principal.

## Fora do escopo

- Detectar participantes, início real ou término real da chamada.
- Autenticação Microsoft própria na extensão.
- Criar, editar, aceitar ou recusar eventos.
- Várias contas ou calendários compartilhados.
- Suporte a outros desktops ou versões de GNOME.
- Fork permanente do Teams for Linux.
- Sincronização entre dispositivos, servidor na nuvem, telemetria.
- Alertas enquanto o computador está suspenso ou a sessão bloqueada.

## Etapa 0 — Validar a fonte de calendário

Consultar o código/documentação correspondente à **versão 2.22.0**, além da documentação atual. Algumas funcionalidades documentadas na branch principal podem ter diferenças de versão.

A documentação pesquisada descreve:

- `graphApi.enabled: true`;
- integração MQTT, com broker local;
- comando `get-calendar`, contendo `startDate` e `endDate`;
- resposta com eventos Graph, incluindo horários e, quando disponível, `onlineMeeting.joinUrl`;
- reaproveitamento da autenticação do Teams for Linux, sujeito às permissões da conta.

Configuração de referência a validar e mesclar com a existente, nunca sobrescrever indiscriminadamente:

```json
{
  "graphApi": { "enabled": true },
  "mqtt": {
    "enabled": true,
    "brokerUrl": "mqtt://localhost:1883",
    "topicPrefix": "teams",
    "commandTopic": "command"
  }
}
```

Exemplo documental do comando:

```json
{
  "action": "get-calendar",
  "startDate": "<início ISO 8601 com offset ou Z>",
  "endDate": "<fim ISO 8601 com offset ou Z>"
}
```

Confirmar no código os tópicos de comando/resposta, paginação, recorrências, semântica de erros e se as respostas são retidas. Não assumir que receber uma mensagem MQTT significa receber uma consulta nova.

### Evidência necessária para seguir

1. Consultar a agenda da conta e comparar dois ou três eventos com o Outlook.
2. Conferir título, início, fim, fuso e link de entrada.
3. Verificar uma ocorrência recorrente e uma alteração/cancelamento, quando houver dados de teste disponíveis.
4. Confirmar como identificar cada ocorrência sem confundir reuniões da mesma série.
5. Verificar se uma resposta inclui todos os eventos do intervalo; não substituir um snapshot completo por uma página parcial.
6. Testar aplicação em segundo plano, desconexão e nova consulta após reconexão.

### Resultado da validação e decisão

- **Consulta autorizada e funcional:** registrar evidência mínima sem dados privados e seguir para a etapa 0B. Usar somente o fluxo normal documentado do aplicativo.
- **Erro de versão ou implementação:** identificar se o comando existe na 2.22.0 e se há correção compatível. Tratar como problema técnico, sem confundir com bloqueio de consentimento. Não atualizar o aplicativo indiscriminadamente nem prometer que uma atualização libera permissões.
- **Erro de autorização/política:** registrar o código e a mensagem sanitizada e interromper a integração real. O próximo caminho é obter autorização da TI para uma integração de leitura de calendário. OAuth próprio seria uma opção somente após autorização, não um fallback automático.
- **Fonte indisponível:** partes independentes podem ser demonstradas com eventos sintéticos, claramente identificados. Isso não significa que a integração real esteja concluída.

Não repetir tentativas de login pelo GNOME, trocar identidades de aplicativo para contornar consentimento, extrair tokens manualmente ou recorrer a scraping como atalho para a política. O bloqueio ao aplicativo GNOME, por si só, não comprova que a consulta normal do Teams for Linux também esteja bloqueada; por isso ela deve ser testada antes de qualquer conclusão.

## Arquitetura mínima proposta — se necessária após a etapa 0B

```text
Teams for Linux autenticado
        ↕ comandos e respostas MQTT
Broker local (Mosquitto, loopback)
        ↕
Serviço local de agenda
        ↓ snapshot JSON gravado atomicamente
Extensão GNOME 50
        → indicador + cartão persistente
```

- **Broker:** reutilizar um existente se disponível; caso contrário, configuração local mínima sem exposição na rede.
- **Serviço:** Python com biblioteca MQTT estabelecida, por exemplo `paho-mqtt`, se não houver opção já adequada no projeto. Evitar implementar o protocolo ou depender de parsing de saída de subprocessos contínuos.
- **Transporte para a extensão:** um arquivo JSON local monitorado por `Gio.FileMonitor`; sem servidor HTTP nem API D-Bus própria no MVP.
- **Extensão:** JavaScript/GJS usando as APIs do GNOME 50. Ela controla relógio, estado visual e ações do usuário.
- **Inicialização:** serviço do usuário via `systemd --user`, após a prova de viabilidade. A extensão deve funcionar visualmente com o serviço ausente e explicar a indisponibilidade.

Validar a opção de cartão não modal persistente na versão instalada do GNOME. Se usar notificações críticas nativas, verificar sua persistência e fechamento; não considerar histórico de notificações equivalente a cartão visível. Preferir uma única implementação visual simples que cumpra os critérios, sem manter dois sistemas de popup.

## Dados e estado

Snapshot mínimo proposto:

```json
{
  "schemaVersion": 1,
  "lastSuccessfulSync": "2026-09-28T19:55:00Z",
  "coverageStart": "2026-09-28T00:00:00Z",
  "coverageEnd": "2026-09-30T00:00:00Z",
  "status": "ok",
  "events": [
    {
      "occurrenceKey": "identificador estável validado na fonte",
      "title": "Daily da equipe",
      "start": "2026-09-28T20:00:00Z",
      "end": "2026-09-28T20:30:00Z",
      "joinUrl": "https://teams.microsoft.com/..."
    }
  ]
}
```

- Normalizar horários para UTC e apresentar no fuso local. Datas Graph podem vir sem offset com um campo separado de fuso; não presumir UTC nem adicionar `Z` sem conversão.
- Filtrar eventos cancelados, recusados, de dia inteiro e compromissos sem indicação de reunião Teams. Documentar o critério real utilizado e revisar com o usuário se excluir eventos esperados.
- Eventos sobrepostos: lista no indicador e cartão que permita acessar todos, sem abrir várias janelas que disputem foco.
- Chave por ocorrência, preservando identidade em reagendamentos sempre que a fonte permitir. Não usar somente título nem somente ID da série.
- Estado local por ocorrência: dispensada/confirmada e prazo de adiamento. Persistir para evitar novos alertas após reiniciar a extensão.
- Uma alteração de horário de ocorrência ainda futura invalida seu agendamento anterior; não ressuscitar automaticamente uma ocorrência já dispensada sem uma regra explícita.
- Ao cancelar/remover evento de um snapshot completo e atualizado, fechar seu alerta e eliminar timers associados.
- Tratar títulos como texto, nunca markup. Validar esquema de links e abrir por API do desktop, sem interpolação em shell.
- Guardar somente dados necessários em diretório privado do usuário; não salvar descrições, participantes, tokens ou conteúdo integral das respostas em logs.

## Sincronização e falhas

- Consulta inicial e atualização a cada 60 segundos, com no máximo uma consulta pendente; ajustar somente se limites reais exigirem.
- Buscar intervalo que inclua eventos já iniciados e próximos eventos, por exemplo ontem até dois dias à frente. Mostrar apenas ocorrências relevantes ao momento.
- Timeout de resposta e retentativa com espera crescente em falhas; evitar loops rápidos.
- Escrever snapshot por substituição atômica, preservando a última agenda válida em falhas.
- Snapshot sem atualização bem-sucedida por mais de 3 minutos: sinalizar agenda desatualizada. Reuniões do cache podem continuar a gerar alertas, claramente marcados como baseados em dados anteriores.
- Resposta vazia válida e erro de consulta são casos diferentes.
- A extensão recalcula a situação a partir do relógio atual, em vez de depender exclusivamente de um timer longo.
- Ao voltar de suspensão/desbloqueio: recalcular eventos, alertar os ainda em andamento e solicitar/aguardar nova sincronização. Não mostrar uma sequência de reuniões já encerradas.
- Reconexão MQTT ou resposta retida não deve resetar `lastSuccessfulSync` sem evidência de consulta atual.
- Reiniciar Teams, broker, serviço ou extensão não deve duplicar alertas já confirmados.

## Etapas de implementação

1. **Viabilidade (etapa 0):** validar versão, permissões e resposta real do calendário; registrar o resultado sem dados privados. Bloqueio corporativo implica interromper a integração real.
2. **Reaproveitamento (etapa 0B):** avaliar Aurora e demais referências com a fonte validada; registrar a escolha entre adaptação pequena e extensão própria.
3. **Fonte e normalização:** serviço pequeno de consulta, conversão de horários e snapshot atômico; usar fixtures sintéticas para testes.
4. **Interface demonstrável:** extensão com indicador, lista e cartão alimentados por snapshot fictício. Incluir comando/modo de demonstração para evento iniciando em poucos segundos.
5. **Comportamento temporal:** início, adiamento, dispensa, sobreposição, fim, retomada após suspensão e persistência das ações.
6. **Integração real:** conectar a fonte validada, conferir links e atualização de eventos; validar no GNOME 50/Wayland real.
7. **Instalação e entrega:** documentar dependências, configuração, ativação, diagnóstico e remoção completa. Não instalar componentes globalmente quando instalação por usuário resolver.

Manter poucos módulos, sem framework de frontend, banco de dados ou abstração genérica para diversos provedores. Criar apenas a estrutura exigida por GJS, serviço e testes.

## Critérios de aceitação

- [ ] Fonte real validada pelo fluxo normal do Teams for Linux; demonstração sintética não conta como integração concluída.
- [ ] Decisão de reaproveitar ou criar a interface documentada após avaliar compatibilidade e manutenção.
- [ ] Com a agenda sincronizada e sessão ativa, o alerta aparece em até 15 segundos do início previsto.
- [ ] O cartão permanece visível até ação explícita ou fim/cancelamento do evento.
- [ ] A notificação contém título/horário reais do calendário, nunca o título da janela do Teams.
- [ ] Não aparecem alertas de chat nesta interface.
- [ ] Entrar abre o link esperado; falha de abertura não confirma silenciosamente a ocorrência.
- [ ] Adiar reapresenta o alerta em aproximadamente 2 minutos, se ainda relevante.
- [ ] Dispensar não silencia próximas ocorrências da mesma série.
- [ ] Uma mesma ocorrência não produz alertas duplicados por sincronização ou reinicialização.
- [ ] Sobreposições são acessíveis sem que uma reunião oculte completamente outra.
- [ ] Cancelamentos/reagendamentos atualizam a interface após uma sincronização bem-sucedida.
- [ ] Voltar da suspensão mostra eventos ainda decorrendo e não dispara eventos encerrados.
- [ ] Fonte indisponível fica visível; erro não é interpretado como agenda vazia.
- [ ] Interface funciona com teclado, não rouba foco e é legível em escala de tela do usuário.
- [ ] Desativar a extensão remove elementos e timers; removê-la não altera o Teams.

## Verificação

Testes automatizados pequenos para normalização, fusos, identidade de ocorrências e transições temporais, usando relógio controlável e dados sintéticos. Não testar Microsoft/Graph com a conta real em CI.

Verificação manual no ambiente alvo: evento próximo, já iniciado, terminado, sobreposto, recorrente, cancelado, reagendado, ausência de rede, reinício e suspensão. A persistência do cartão e o comportamento de foco precisam de validação real no GNOME, não apenas de teste unitário.

## Fontes e limites da pesquisa

Consultadas durante o planejamento em 28/09/2026; rever na implementação:

- [Teams for Linux — MQTT e exportação de calendário](https://ismaelmartinez.github.io/teams-for-linux/mqtt-integration/)
- [Configuração do Teams for Linux](https://github.com/IsmaelMartinez/teams-for-linux/blob/main/docs-site/docs/configuration.md)
- [Microsoft Graph — calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)
- [GNOME 50 — origem do aviso “is ready”](https://github.com/GNOME/gnome-shell/blob/gnome-50/js/ui/windowAttentionHandler.js)

Fontes dos novos achados:

- [Aurora Shell — descrição visual](https://aurora.luminusos.org/pt-br/)
- [Aurora Shell — versões para GNOME 50](https://extensions.gnome.org/extension/9389/aurora-shell/)
- [Aurora Shell — código e módulos](https://github.com/luminusOS/aurora-shell)
- [Calendar Reminders — extensão](https://extensions.gnome.org/extension/10791/calendar-reminders/)
- [Calendar Reminders — funcionamento e limitações](https://github.com/donnybeelo/gnome-extensions-calendar-reminders)
- [Evolution Data Server — configurações da janela de lembretes](https://github.com/GNOME/evolution-data-server/blob/master/data/org.gnome.evolution-data-server.calendar.gschema.xml.in)
- [GNOME 47 — integração Microsoft 365](https://release.gnome.org/47/)
- [Dim Completed Calendar Events](https://extensions.gnome.org/extension/5979/dim-completed-calendar-events/)
- [Next Up — versões publicadas](https://extensions.gnome.org/extension/5465/next-up/)
- [GNOME Next Meeting Applet — repositório arquivado](https://github.com/chmouel/gnome-next-meeting-applet)
- [Eventix](https://github.com/hrniels/Eventix)

O detector experimental `meeting-started` não é necessário neste MVP. A integração MQTT de calendário foi documentada, mas não foi executada ou validada na conta do usuário nesta conversa. Nenhum componente foi implementado ou instalado por este plano.

## Prompt sugerido para a nova tarefa

> Trabalhe no MVP descrito em PLANO-MVP.md neste diretório. A organização bloqueia o aplicativo GNOME nas Contas Online; não repetir essa configuração. Comece validando a consulta normal de calendário do Teams for Linux 2.22.0 via integração documentada Graph/MQTT, sem presumir que o login web autoriza a API. Se funcionar, avalie o módulo de calendário do Aurora Shell antes de criar uma interface própria. Escolha a menor adaptação sustentável que atenda aos critérios; não imponha MQTT/snapshot a uma interface que não os suporta sem avaliar o custo. Preserve configurações existentes. Se houver bloqueio de autorização, documente a necessidade de aprovação da TI e interrompa a integração real; avance apenas em demonstrações independentes com dados sintéticos, sem apresentar o MVP como concluído. Não extrair tokens nem contornar políticas. Valide no GNOME 50 a persistência visual, foco, adiamento e retomada após suspensão. O objetivo é alertar pelo horário do calendário, sem afirmar que a chamada começou de fato.
