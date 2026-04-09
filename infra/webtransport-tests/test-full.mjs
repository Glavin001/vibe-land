import { chromium } from "playwright";
import { createServer } from "https";
import { readFileSync } from "fs";

// Configure via environment: WT_DOMAIN=wt.yourdomain.com
const DOMAIN = process.env.WT_DOMAIN;
if (!DOMAIN) { console.error("Set WT_DOMAIN env var (e.g. WT_DOMAIN=wt.yourdomain.com)"); process.exit(1); }
const CERT_DIR = process.env.WT_CERT_DIR || `/etc/letsencrypt/live/${DOMAIN}`;
const WT_URL = `https://${DOMAIN}/echo`;

async function main() {
  const server = createServer({
    cert: readFileSync(`${CERT_DIR}/fullchain.pem`),
    key: readFileSync(`${CERT_DIR}/privkey.pem`),
  }, (req, res) => { res.writeHead(200, {"Content-Type": "text/html"}); res.end("<html><body>test</body></html>"); });
  server.listen(8443);

  const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--no-sandbox", "--enable-quic"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.on("console", (msg) => console.log(`  [PAGE] ${msg.text()}`));
  await page.goto("https://localhost:8443");

  const result = await page.evaluate(async (url) => {
    const results = {};

    // 1. Connection test
    try {
      const transport = new WebTransport(url);
      await Promise.race([
        transport.ready,
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 10000))
      ]);
      results.connection = "PASS";

      // 2. Datagram test (send + receive echo-style)
      try {
        const dgWriter = transport.datagrams.writable.getWriter();
        const dgReader = transport.datagrams.readable.getReader();

        // Send arbitrary bytes — /echo just echoes them back unchanged
        const testData = "echo-test-" + Date.now();
        await dgWriter.write(new TextEncoder().encode(testData));
        dgWriter.releaseLock();

        const { value } = await Promise.race([
          dgReader.read(),
          new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5000))
        ]);
        const echoed = new TextDecoder().decode(value);
        results.datagram_send = "PASS";
        results.datagram_receive = echoed === testData ? "PASS" : "FAIL (got: " + echoed + ")";
        dgReader.releaseLock();
      } catch (e) {
        results.datagram_send = "FAIL: " + e.message;
        results.datagram_receive = "SKIPPED";
      }

      // 3. Bidirectional stream test (client-initiated)
      try {
        console.log("Testing client-initiated bidi stream...");
        const stream = await transport.createBidirectionalStream();
        results.bidi_stream_create = "PASS";

        const writer = stream.writable.getWriter();
        await writer.write(new TextEncoder().encode("stream test"));
        results.bidi_stream_write = "PASS";

        // Try to read the echo back (if server echoes on streams)
        // For our chat server, the broadcast comes back as a datagram, not on the stream
        // So just test that write doesn't error
        await writer.close();
        results.bidi_stream_close = "PASS";
      } catch (e) {
        results.bidi_stream_create = results.bidi_stream_create || "FAIL: " + e.message;
        results.bidi_stream_write = results.bidi_stream_write || "FAIL: " + e.message;
        results.bidi_stream_close = "FAIL: " + e.message;
      }

      // 4. Server-initiated stream test
      // (Our server doesn't initiate streams, skip)

      // 5. Unidirectional stream test (client-initiated)
      try {
        console.log("Testing client-initiated uni stream...");
        const stream = await transport.createUnidirectionalStream();
        const writer = stream.getWriter();
        await writer.write(new TextEncoder().encode("uni test"));
        await writer.close();
        results.uni_stream = "PASS";
      } catch (e) {
        results.uni_stream = "FAIL: " + e.message;
      }

      // 6. Multiple rapid datagrams
      // Note: WebTransport datagrams are dropped if the readable isn't being consumed.
      // We read in the background while sending concurrently.
      try {
        console.log("Testing rapid datagrams...");
        const reader = transport.datagrams.readable.getReader();
        const writer = transport.datagrams.writable.getWriter();
        const sent = 20;
        let received = 0;

        // Start draining echoes in the background immediately
        const drainDone = new Promise(resolve => {
          (async () => {
            const deadline = Date.now() + 3000;
            while (received < sent && Date.now() < deadline) {
              const result = await Promise.race([
                reader.read(),
                new Promise((_, r) => setTimeout(() => r(new Error("timeout")), Math.max(1, deadline - Date.now())))
              ]).catch(() => ({ done: true }));
              if (result.done) break;
              received++;
            }
            reader.releaseLock();
            resolve();
          })();
        });

        // Send all 20 concurrently with the drain loop running
        for (let i = 0; i < sent; i++) {
          await writer.write(new TextEncoder().encode("dg-" + i));
        }
        writer.releaseLock();
        await drainDone;

        const pct = Math.round(received / sent * 100);
        results.rapid_datagrams = sent + " sent, " + received + " received (" + pct + "% delivery)";
      } catch (e) {
        results.rapid_datagrams = "FAIL: " + e.message;
      }

      // 7. Connection stats
      try {
        const stats = transport.congestionControl;
        results.congestion_control = stats || "not available";
      } catch (e) {
        results.congestion_control = "not available";
      }

      // 8. Max datagram size
      try {
        results.max_datagram_size = transport.datagrams.maxDatagramSize || "unknown";
      } catch (e) {
        results.max_datagram_size = "unknown";
      }

      transport.close();
    } catch (e) {
      results.connection = "FAIL: " + e.message;
    }

    return results;
  }, WT_URL);

  console.log("\n=== WebTransport Full Capability Test ===\n");
  const tests = Object.entries(result);
  let passed = 0, failed = 0;
  for (const [name, status] of tests) {
    const icon = typeof status === "string" && status.startsWith("PASS") ? "OK" : typeof status === "string" && status.startsWith("FAIL") ? "FAIL" : "INFO";
    if (icon === "OK") passed++;
    if (icon === "FAIL") failed++;
    const label = name.replace(/_/g, " ").padEnd(25);
    console.log(`  ${icon.padEnd(4)}  ${label}  ${status}`);
  }
  console.log(`\n  ${passed} passed, ${failed} failed, ${tests.length - passed - failed} info\n`);

  await browser.close();
  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
