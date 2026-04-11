# WebTransport Server Setup — Hetzner Cloud

Step-by-step guide to hosting a publicly-accessible WebTransport (HTTP/3 + QUIC) server on a Hetzner Cloud VPS. Based on a working, tested deployment.

---

## Prerequisites

- A **domain name** you control (e.g. `wt.yourdomain.com`)
- A **Hetzner Cloud** account ([console.hetzner.cloud](https://console.hetzner.cloud))
- SSH key added to your Hetzner account

---

## 1. Create the VPS

In Hetzner Cloud Console:

1. **New Project** → give it a name
2. **Add Server**
   - Location: pick one close to your players (e.g. Ashburn for east-coast NA)
   - Image: **Ubuntu 24.04**
   - Type: **CX22** (2 vCPU, 4 GB RAM, ~€4.35/mo) — sufficient for testing and small deployments
   - SSH Key: select yours
3. Click **Create & Buy Now**

Note the **public IPv4 address** after creation.

---

## 2. DNS

At your DNS provider, create an **A record** pointing your subdomain to the server IP:

```
wt.yourdomain.com  →  <YOUR_SERVER_IP>  (TTL: 300)
```

Verify propagation:
```bash
dig +short wt.yourdomain.com
# Should return your server IP
```

---

## 3. Hetzner Cloud Firewall (CRITICAL)

Hetzner's firewall is a **stateless packet filter** — it does NOT track connections. You must explicitly allow inbound UDP for QUIC and the ephemeral port range for responses.

**This is the most common cause of WebTransport failures on Hetzner.** If you see `QUIC_NETWORK_IDLE_TIMEOUT` with `num_undecryptable_packets: 0`, this is why.

In Hetzner Cloud Console → **Firewalls** → **Create Firewall**:

### Inbound Rules

| Protocol | Port        | Source     | Description              |
|----------|-------------|------------|--------------------------|
| TCP      | 22          | 0.0.0.0/0 | SSH                      |
| TCP      | 80          | 0.0.0.0/0 | HTTP (Let's Encrypt)     |
| TCP      | 443         | 0.0.0.0/0 | HTTPS                    |
| **UDP**  | **443**     | 0.0.0.0/0 | **QUIC / WebTransport**  |
| UDP      | 32768-65535 | 0.0.0.0/0 | UDP ephemeral (responses)|

After creating the firewall, **apply it to your server** — this is a separate step in the console.

### UFW (on the server itself)

```bash
ssh root@<YOUR_SERVER_IP>

ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw enable
ufw status
```

---

## 4. TLS Certificate

WebTransport requires a valid CA-signed certificate. Self-signed certs only work with `serverCertificateHashes` (14-day expiry limit — not practical for production).

```bash
# Install certbot
snap install --classic certbot
ln -sf /snap/bin/certbot /usr/bin/certbot

# Obtain cert (nothing must be listening on port 80)
certbot certonly --standalone --preferred-challenges http \
  -d wt.yourdomain.com \
  --agree-tos -m you@email.com --non-interactive
```

Certificates are saved at:
```
/etc/letsencrypt/live/wt.yourdomain.com/fullchain.pem
/etc/letsencrypt/live/wt.yourdomain.com/privkey.pem
```

Auto-renewal is configured automatically by the snap install. Verify it works:
```bash
certbot renew --dry-run
```

Add a post-renewal hook to restart the server after cert renewal:
```bash
cat > /etc/letsencrypt/renewal-hooks/post/restart-wt.sh << 'EOF'
#!/bin/bash
systemctl restart webtransport
EOF
chmod +x /etc/letsencrypt/renewal-hooks/post/restart-wt.sh
```

---

## 5. Runtime Dependencies

```bash
# Go 1.24+ (matches go.mod in webtransport-demo)
wget https://go.dev/dl/go1.24.0.linux-amd64.tar.gz
tar -C /usr/local -xzf go1.24.0.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc
go version  # should print go1.24.0

# Node.js via nvm (for Playwright tests)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22

# Playwright + Chrome (for automated tests)
cd /path/to/infra/webtransport-tests
npm install
npx playwright install chrome
npx playwright install-deps chromium
apt-get install -y xvfb
```

> **Note on Go toolchain:** The demo module requires Go 1.24. If you install an older version, Go will auto-download the required toolchain on first build — this requires internet access and takes 30–60 seconds with no output. Installing Go 1.24+ directly avoids this.

---

## 6. Demo Server

A standalone Go WebTransport server for verifying infrastructure independently of the Rust game server.

```bash
# Copy or clone the repo, then:
cd infra/webtransport-demo

# Configure your domain
export WT_DOMAIN=wt.yourdomain.com
# Optional: export WT_CERT_DIR=/path/to/certs  (defaults to /etc/letsencrypt/live/$WT_DOMAIN)

# Download dependencies and build
go mod download
go build -o webtransport-server .

# Test it manually
./webtransport-server
```

Then open `https://wt.yourdomain.com/` in Chrome to see the chat demo, or `/diag` to run the diagnostic tests.

### Deploy as a systemd Service

```bash
# Copy binary to deployment location
mkdir -p /opt/webtransport
cp webtransport-server /opt/webtransport/

# Install the service (edit WT_DOMAIN before copying)
cp webtransport.service /etc/systemd/system/webtransport.service

# Edit the service file — update WT_DOMAIN and paths as needed:
#   Environment=WT_DOMAIN=wt.yourdomain.com
#   ExecStart=/opt/webtransport/webtransport-server
#   WorkingDirectory=/opt/webtransport
nano /etc/systemd/system/webtransport.service

systemctl daemon-reload
systemctl enable webtransport
systemctl start webtransport
systemctl status webtransport
journalctl -u webtransport -f
```

---

## 7. Running Tests

### Browser diagnostic (manual — tests the full external network path)

Open `https://wt.yourdomain.com/diag` in Chrome or Edge and click **Run All Tests**.

Covers: QUIC connection, datagram echo + throughput, bidi stream echo, 5 concurrent streams, uni streams, latency stats (min/avg/p95/max).

### Playwright tests (automated, run from the server)

```bash
cd infra/webtransport-tests
npm install

export WT_DOMAIN=wt.yourdomain.com
xvfb-run --auto-servernum node test-full.mjs    # Full capability test against /echo
xvfb-run --auto-servernum node test-chat2.mjs   # Two-client chat broadcast test
```

> **Note:** Playwright tests run from the server use localhost, which bypasses the Hetzner Cloud firewall. Use the `/diag` browser page to validate from an external network.

---

## 8. Verification Checklist

Work through this top-to-bottom when something isn't working:

```bash
# 1. DNS resolves to your server
dig +short wt.yourdomain.com

# 2. TLS cert is valid and uses ALPN h3
openssl s_client -connect wt.yourdomain.com:443 -alpn h3 < /dev/null 2>&1 | grep -E "subject|issuer|verify"

# 3. Server is listening on UDP 443 (QUIC)
ss -ulnp | grep 443

# 4. UFW allows both TCP and UDP 443
ufw status | grep 443

# 5. Hetzner Cloud firewall has UDP 443 inbound rule AND is applied to the server
#    Check: Console → Firewalls → your firewall → Inbound rules + Applied to servers

# 6. Server is running and healthy
systemctl status webtransport
journalctl -u webtransport -f

# 7. HTTP health check (TCP path)
curl -s https://wt.yourdomain.com/health
```

---

## 9. Lessons Learned

### What broke and how we fixed it

**1. `QUIC_NETWORK_IDLE_TIMEOUT` / `num_undecryptable_packets: 0`**
- Cause: UDP 443 blocked by the **Hetzner Cloud firewall** (separate from UFW on the server)
- Fix: Add UDP 443 inbound rule in Hetzner console, then apply the firewall to the server

**2. `NO_APPLICATION_PROTOCOL` / TLS handshake failure** *(Go/quic-go specific)*
- Cause: TLS config missing ALPN negotiation
- Fix: Add `NextProtos: []string{"h3"}` to the `tls.Config`

**3. `ERR_METHOD_NOT_SUPPORTED`** *(Go/quic-go specific)*
- Cause: HTTP handlers registered on `http.DefaultServeMux` instead of the HTTP/3 server's handler
- Fix: Create `http.NewServeMux()`, assign it to `server.H3.Handler`, and call `webtransport.ConfigureHTTP3Server(server.H3)` to enable datagrams and WebTransport settings

**4. `WebTransport is not defined` in Playwright**
- Cause: Playwright's bundled Chromium headless shell strips the WebTransport API
- Fix: Install real Google Chrome (`npx playwright install chrome`), use `channel: "chrome"`, `headless: false`, and `xvfb-run` for a virtual display. The page must also be served from a secure context (HTTPS).

**5. Client bidi streams not reaching server from external browsers**
- Observed: datagrams worked, but `createBidirectionalStream()` writes were silently dropped
- Workaround: switched to datagrams for the chat demo (datagrams are preferred for low-latency game traffic anyway)
- Verified: the `/echo` diagnostic endpoint confirms both streams and datagrams work end-to-end from external browsers — the issue was specific to the chat handler code path

### Architecture notes

- Port 443 serves two protocols simultaneously: **TCP** (regular HTTPS, for serving pages) and **UDP** (QUIC/HTTP3, for WebTransport). Both listeners bind to the same port number.
- `webtransport.ConfigureHTTP3Server()` must be called before serving — it sets the HTTP/3 SETTINGS frame to advertise WebTransport support and enables QUIC datagrams.
- **Max datagram size: 1024 bytes** (observed from Chrome). Design your game packet format to fit within this. For the Rust server, the `wtransport` crate exposes the negotiated MTU.
- Chrome and Edge fully support WebTransport. Firefox support is behind a flag. Safari does not support it.
- Hetzner Ashburn tested latency: ~31ms avg to east-coast clients, very consistent (30–32ms jitter). Suitable for real-time games.

---

## 10. Transitioning to the Rust Game Server

The Go demo server validates infrastructure. The game will use the Rust `wtransport` crate (already declared in `server/Cargo.toml`).

Key facts for the transition:
- The `wtransport` crate handles QUIC/HTTP3 natively — no manual ALPN or handler routing required
- `server/src/protocol.rs` already has `ClientDatagram`, `ServerReliablePacket`, `ServerDatagramPacket` encode/decode functions ready to use
- `client/src/net/webTransportClient.ts` is a complete WebTransport client, only needs the server endpoint wired up
- The Go demo server and `/diag` page remain useful for verifying infrastructure independently of the game server
- Rust server env vars: `BIND_ADDR`, `WT_PORT`, `PUBLIC_WT_HOST` (see `NETCODE_NOTES.md`)
