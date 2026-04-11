# WebTransport Playwright Tests

Automated browser tests for verifying WebTransport connectivity using real Google Chrome.

## Setup

```bash
npm install
npx playwright install chrome
npx playwright install-deps chromium
apt-get install -y xvfb  # virtual display for headless environments
```

## Tests

### Full capability test
Tests connection, datagrams, bidi streams, concurrent streams, uni streams against the `/echo` endpoint.

```bash
WT_DOMAIN=wt.yourdomain.com xvfb-run --auto-servernum node test-full.mjs
```

### Two-client chat test
Connects two browser instances and verifies cross-client message broadcast.

```bash
WT_DOMAIN=wt.yourdomain.com xvfb-run --auto-servernum node test-chat2.mjs
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WT_DOMAIN` | Yes | — | Your domain (e.g. `wt.yourdomain.com`) |
| `WT_CERT_DIR` | No | `/etc/letsencrypt/live/$WT_DOMAIN` | Directory containing `fullchain.pem` and `privkey.pem` |

## Notes

- Tests run from the server use localhost, bypassing the Hetzner Cloud firewall
- For external network testing, use the `/diag` page in a real browser
- Requires Google Chrome (not Playwright's bundled Chromium) because the headless shell strips the WebTransport API
