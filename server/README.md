# PulseShare Relay (servidor)

Um nó da rede PulseShare para deixar rodando 24 h num servidor Linux. Tudo em modo texto.

## Instalar (arquivo único)

```bash
curl -fsSLO https://ricardoazt.github.io/share/downloads/pulseshare-relay.sh
sudo bash pulseshare-relay.sh
```

Ou com o pacote `.tar.gz` (gerado por `./build-tar.sh` junto com o `.sh`):

```bash
tar xzf pulseshare-relay-*.tar.gz
cd pulseshare-relay
sudo ./install.sh
```

O instalador instala o Node.js (se faltar), cria o usuário de sistema `pulseshare`, o serviço
`pulseshare-relay` (systemd) e abre o configurador.

## Configurar (a qualquer momento)

```bash
sudo pulseshare-relay config
```

- **Conta**: cria uma conta nova (mostra as 7 palavras, a chave de acesso e o hash) ou entra
  com as 7 palavras / chave de uma conta existente. O nome de usuário é conferido na rede (único).
- **Nome do perfil**: o nome que as pessoas veem (livre).
- **Banda de download / upload** (kbit/s), **tráfego mensal** (GB; ao atingir, o relay pausa até o
  mês seguinte), **limite de conexões** (usuários atendidos ao mesmo tempo).
- **Caixa postal**: guarda mensagens para quem está offline e entrega quando a pessoa volta.
- **Relay TURN** (coturn): os apps usam o servidor para passar arquivos quando a conexão direta
  não abre. Libere 3478/udp+tcp e 49152–65535/udp no firewall.

## Outros comandos

```bash
pulseshare-relay status     # situação, tráfego, caixa postal
pulseshare-relay logs       # registro ao vivo
pulseshare-relay restart
sudo pulseshare-relay account --palavras   # mostra as 7 palavras da conta
sudo bash pulseshare-relay.sh --uninstall  # remove (mantém conta e dados)
sudo bash pulseshare-relay.sh --purge      # remove tudo
```
