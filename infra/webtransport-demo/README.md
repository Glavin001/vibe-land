# WebTransport Demo Server

Standalone Go server for verifying WebTransport infrastructure independently of the Rust game server.

## What it does

- Serves a chat demo page over HTTPS (TCP 443)
- Runs a WebTransport chat room (UDP 443) — open two tabs, messages broadcast between them
- Serves a diagnostic page at `/diag` that tests all WebTransport capabilities
- Provides an `/echo` endpoint for stream/datagram testing

## Building

```bash
go build -o webtransport-server .
```

## Running

Requires a TLS certificate (e.g. from Let's Encrypt). Set the domain via environment variable:

```bash
WT_DOMAIN=wt.yourdomain.com ./webtransport-server
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WT_DOMAIN` | Yes | — | Your domain (e.g. `wt.yourdomain.com`) |
| `WT_CERT_DIR` | No | `/etc/letsencrypt/live/$WT_DOMAIN` | Directory containing `fullchain.pem` and `privkey.pem` |

## Endpoints

| Path | Transport | Description |
|------|-----------|-------------|
| `/` | HTTPS (TCP) | Chat demo page |
| `/diag` | HTTPS (TCP) | Diagnostic test page |
| `/health` | HTTPS (TCP) | Health check |
| `/wt` | WebTransport (UDP) | Chat room (datagrams) |
| `/echo` | WebTransport (UDP) | Echo server (streams + datagrams) |
