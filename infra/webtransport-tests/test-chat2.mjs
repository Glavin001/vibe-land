import { chromium } from "playwright";
import { createServer } from "https";
import { readFileSync } from "fs";

// Configure via environment: WT_DOMAIN=wt.yourdomain.com
const DOMAIN = process.env.WT_DOMAIN;
if (!DOMAIN) { console.error("Set WT_DOMAIN env var (e.g. WT_DOMAIN=wt.yourdomain.com)"); process.exit(1); }
const CERT_DIR = process.env.WT_CERT_DIR || `/etc/letsencrypt/live/${DOMAIN}`;

async function main() {
  const server = createServer({
    cert: readFileSync(`${CERT_DIR}/fullchain.pem`),
    key: readFileSync(`${CERT_DIR}/privkey.pem`),
  }, (req, res) => { res.writeHead(200, {"Content-Type": "text/html"}); res.end("<html><body>test</body></html>"); });
  server.listen(8443);

  const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--no-sandbox", "--enable-quic"] });
  const url = `https://${DOMAIN}/wt`;

  async function createClient(label) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    page.on("console", (msg) => console.log(`[${label}] ${msg.text()}`));
    await page.goto("https://localhost:8443");

    // Connect and start draining datagrams into window.received immediately
    await page.evaluate(async (url) => {
      window.received = [];
      window.wt = new WebTransport(url);
      await window.wt.ready;
      console.log("Connected");
      // Drain loop — must be running before any datagrams arrive
      (async () => {
        const reader = window.wt.datagrams.readable.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          try {
            const msg = JSON.parse(new TextDecoder().decode(value));
            console.log("GOT: " + JSON.stringify(msg));
            window.received.push(msg);
          } catch {}
        }
      })();
    }, url);
    return page;
  }

  const page1 = await createClient("Client1");
  const page2 = await createClient("Client2");

  // Wait for both join messages to propagate
  await new Promise(r => setTimeout(r, 500));

  // Client1 sends a chat message via datagram (matches what the demo page does)
  console.log("\n--- Client1 sending chat ---");
  await page1.evaluate(async () => {
    const writer = window.wt.datagrams.writable.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify({ type: "chat", text: "hello from client 1" })));
    writer.releaseLock();
    console.log("Sent chat datagram");
  });

  // Wait for broadcast to arrive at Client2 (poll up to 3s)
  const received = await page2.waitForFunction(
    () => window.received.some(m => m.type === "chat"),
    { timeout: 3000 }
  ).then(() => true).catch(() => false);

  const r1 = await page1.evaluate(() => window.received);
  const r2 = await page2.evaluate(() => window.received);

  console.log("\nClient1 received:", JSON.stringify(r1.map(m => m.type + (m.text ? ": " + m.text : ""))));
  console.log("Client2 received:", JSON.stringify(r2.map(m => m.type + (m.text ? ": " + m.text : ""))));

  const chatInClient2 = r2.find(m => m.type === "chat");
  const chatInClient1 = r1.find(m => m.type === "chat");

  console.log("\n=== Chat Broadcast Test Results ===");
  console.log("  " + (chatInClient1 ? "OK  " : "FAIL") + "  Sender received own message broadcast");
  console.log("  " + (chatInClient2 ? "OK  " : "FAIL") + "  Recipient received message: " + (chatInClient2?.text || "—"));

  const passed = chatInClient1 && chatInClient2;
  console.log("\n" + (passed ? "ALL TESTS PASSED" : "SOME TESTS FAILED"));

  await browser.close();
  server.close();
  process.exit(passed ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
