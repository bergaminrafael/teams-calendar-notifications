# Teams Calendar Notification

Indicador e cartão persistente para reuniões Teams agendadas no GNOME 50. O Teams for Linux 2.22.0 fornece eventos pelo comando MQTT `get-calendar`; um serviço Python grava apenas os campos necessários em um snapshot local. A extensão não autentica no Microsoft 365.

## Estado atual

- A consulta Graph/MQTT foi validada com uma resposta real da conta: eventos Teams, links e ocorrências recorrentes chegaram, com horários em UTC. O projeto não guarda essa resposta privada.
- A normalização e os testes automatizados funcionam com dados sintéticos. O cartão ainda precisa de verificação manual na sessão GNOME 50/Wayland, especialmente persistência, foco, teclado e retomada da suspensão.
- Quando o Graph pagina uma resposta, o serviço divide o intervalo de tempo e reúne os eventos antes de atualizar o snapshot. Fusos Graph fora de UTC ou nomes IANA também precisam de validação com dados reais.

## Configuração

1. Mantenha `graphApi.enabled: true` e `mqtt.commandTopic: "command"` na configuração do Teams for Linux.
2. Crie uma credencial MQTT **separada** para o serviço: leitura em `teams/calendar`, escrita em `teams/command`. Guarde a senha com `pass insert mqtt/teams-calendar`; a primeira linha da entrada deve ser a senha. A credencial do Teams continua com seu acesso próprio. Use TLS e ACL no broker.
3. Copie `config.example.json` para `~/.config/teams-calendar-notification/config.json`, substitua endereço, usuário e `passwordEntry`, e defina permissão `0600`. O serviço chama `pass show` sem shell ao iniciar e nunca grava a senha no snapshot. Configure `caFile` conforme a seção abaixo.
4. Instale a dependência em um ambiente virtual no projeto: `uv venv .venv --python /usr/bin/python3` e `uv pip install --python .venv/bin/python -r requirements.txt`. Neste Ubuntu, `python3 -m venv` requer o pacote adicional `python3.14-venv`; `uv` já está disponível.

### Certificado da CA MQTT

O arquivo `ca.crt` é o **certificado público da autoridade certificadora (CA)** que assinou o certificado TLS do broker MQTT. Ele não contém a chave privada e não é usado diretamente pela extensão GNOME: o serviço Python o carrega por `caFile` ao conectar a um `brokerUrl` com `mqtts://`. A configuração atual aponta para `ca.crt` na raiz deste projeto; o arquivo é local e está fora do Git. Como essa CA não está no repositório de confiança do sistema, `caFile` é necessário para a conexão atual. Se o broker usar um certificado de uma CA pública já confiável pelo sistema, omita `caFile`.

Para configurar outro cliente, obtenha o **certificado da CA que assinou o certificado do broker** com quem administra o MQTT. Não gere uma CA nova apenas no cliente: ela não validará o certificado já instalado no broker. Guarde o certificado PEM em um caminho estável e informe o caminho absoluto no `config.json`:

```json
{
  "brokerUrl": "mqtts://broker.example.org:8883",
  "caFile": "/caminho/absoluto/para/ca.crt"
}
```

Se você também administra o broker e precisa criar uma CA própria, faça isso em um diretório privado **fora deste repositório**. O comando abaixo cria `ca.crt` e uma `ca.key` protegida por senha; o certificado TLS do broker ainda precisa ser emitido por essa CA e conter o nome do host usado em `brokerUrl` no campo Subject Alternative Name (SAN):

```sh
openssl req -new -x509 -newkey rsa:4096 -sha256 -days 3650 \
  -keyout ca.key -out ca.crt -subj '/CN=Minha CA MQTT' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
```

Copie **somente `ca.crt`** para a máquina que executa este serviço. Mantenha `ca.key` privada; ela não deve ficar junto da extensão nem ser enviada ao GitHub. Depois de configurar o certificado do broker, confira a conexão TLS, substituindo host e caminho pelos valores reais:

```sh
openssl s_client -connect broker.example.org:8883 \
  -servername broker.example.org -verify_hostname broker.example.org \
  -CAfile /caminho/absoluto/para/ca.crt -verify_return_error -brief </dev/null
```

Veja também a [documentação TLS do Mosquitto](https://mosquitto.org/man/mosquitto-tls-7.html) para emitir o certificado do broker e a [documentação do Paho MQTT](https://eclipse.dev/paho/files/paho.mqtt.python/html/client.html#paho.mqtt.client.Client.tls_set) para o comportamento de `caFile`.

## Executar

Para testar o cartão sem MQTT, execute `python3 service/calendar_sync.py --demo`. Isso grava uma reunião explicitamente sintética que começa em 10 segundos e termina após cinco minutos.

Para usar a agenda real, execute `.venv/bin/python service/calendar_sync.py`. O snapshot fica em `~/.local/state/teams-calendar-notification/snapshot.json`, com diretório privado. O serviço consulta a cada 60 segundos, preserva os últimos eventos válidos em falhas; a extensão avisa quando a última sincronização tem mais de três minutos.

Instale a extensão por usuário copiando o diretório `extension/teams-calendar-notification@local` para `~/.local/share/gnome-shell/extensions/`, depois habilite com `gnome-extensions enable teams-calendar-notification@local`. Em Wayland, saia e entre novamente na sessão após instalar ou alterar o JavaScript da extensão: desabilitar e habilitar reutiliza o módulo em cache. Para iniciar o serviço automaticamente, ajuste `ExecStart` se o projeto estiver em outro diretório, execute `systemctl --user link "$PWD/systemd/teams-calendar-notification.service"`, `systemctl --user daemon-reload` e, **depois de criar o arquivo de configuração**, `systemctl --user enable --now teams-calendar-notification.service`.

Diagnóstico: `systemctl --user status teams-calendar-notification.service`, `journalctl --user -u teams-calendar-notification.service -n 50` e `gnome-extensions info teams-calendar-notification@local`. Rode `python3 -m unittest discover -s tests` e `node tests/test_logic.mjs` para os testes automatizados. O serviço nunca registra título, participantes, link nem conteúdo bruto das respostas.

## Comportamento

O indicador mostra o título da reunião em andamento ou, quando não houver uma, o tempo até a próxima reunião **de hoje** (`- 26m`, `- 1h34`, `- 2h`). Se só houver reuniões amanhã, o texto fica vazio. O número dentro do calendário indica quantas reuniões marcadas para hoje no fuso local ainda não terminaram, incluindo as futuras e as que estão em andamento. De `0` a `9`, o número aparece dentro do ícone; a partir de `10`, a contagem exata aparece ao lado. O cartão aparece enquanto uma reunião está no horário e só fecha ao entrar, adiar, dispensar, terminar ou desaparecer de um snapshot atualizado. `Entrar` envia links de reunião reconhecidos ao manipulador `msteams://`, que pode ser o Teams for Linux; outros links usam o navegador padrão. O menu do indicador lista eventos atuais e próximos e permite reabrir um cartão dispensado. Ações são guardadas por ocorrência em `~/.local/state/teams-calendar-notification/actions.json`; uma recorrência futura não herda a dispensa da anterior.

O alerta segue o **horário do calendário**. Ele não afirma que alguém entrou na chamada. Após três minutos sem sincronização bem-sucedida, um pequeno badge âmbar aparece depois do texto do indicador. O nome da reunião, o cartão e a agenda do clique esquerdo continuam usando os eventos salvos, respeitando o horário de término. O badge desaparece automaticamente quando a sincronização volta.

O **clique direito** no indicador abre o status da sincronização, com a data da última atualização e a ação **Ver diagnóstico…**. Com o indicador focado, a tecla de menu ou `Shift+F10` também abre esse menu. O diagnóstico lê os últimos 50 registros do serviço sem bloquear o GNOME e permite copiá-los junto com o status. A janela mostra os dados do momento em que foi aberta; reabra para atualizar. O menu do clique esquerdo permanece exclusivo para a agenda.

Um som de notificação do tema do GNOME toca quando uma reunião passa a exigir atenção, inclusive ao retornar de um adiamento ou reabrir um cartão dispensado. Atualizações do cartão e o botão `Próxima` não repetem o som; reuniões que chegam juntas produzem um único aviso. A reprodução usa as configurações de som do sistema. Para verificar, use a reunião sintética de `--demo` e teste também `Adiar 2 min`.

## Remover

Execute `systemctl --user disable --now teams-calendar-notification.service` e `gnome-extensions disable teams-calendar-notification@local`. Depois remova a cópia da extensão, o link da unidade do usuário, o ambiente virtual e os arquivos de configuração/estado se não quiser manter credenciais ou histórico de dispensas. Nada altera a instalação do Teams for Linux.
