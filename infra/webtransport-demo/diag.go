package main

const diagHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WebTransport Diagnostics</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: monospace; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { margin-bottom: 16px; }
  #log { background: #1e293b; padding: 16px; border-radius: 8px; line-height: 1.8; min-height: 400px; white-space: pre-wrap; }
  .pass { color: #22c55e; }
  .fail { color: #ef4444; }
  .info { color: #38bdf8; }
  .warn { color: #eab308; }
  button { background: #2563eb; color: white; border: none; padding: 10px 24px; border-radius: 6px; font-size: 16px; cursor: pointer; margin-bottom: 16px; }
  button:hover { background: #1d4ed8; }
  button:disabled { background: #334155; }
</style>
</head>
<body>
<h1>WebTransport Diagnostics</h1>
<button id="runBtn" onclick="runTests()">Run All Tests</button>
<div id="log"></div>
<script>
const ECHO_URL = window.location.origin.replace("http://", "https://") + "/echo";
const el = document.getElementById("log");

function log(msg, cls) {
  const span = document.createElement("span");
  span.className = cls || "";
  span.textContent = msg + "\n";
  el.appendChild(span);
  el.scrollTop = el.scrollHeight;
}

function pass(name) { log("  PASS  " + name, "pass"); }
function fail(name, err) { log("  FAIL  " + name + " — " + err, "fail"); }
function info(name) { log("  INFO  " + name, "info"); }

async function runTests() {
  document.getElementById("runBtn").disabled = true;
  el.innerHTML = "";
  log("=== WebTransport Diagnostic Tests ===\n");

  // 0. API check
  if (typeof WebTransport === "undefined") {
    fail("WebTransport API", "not available in this browser");
    return;
  }
  pass("WebTransport API available");

  let transport;

  // 1. Connection
  log("\n--- Connection ---");
  try {
    transport = new WebTransport(ECHO_URL);
    await Promise.race([
      transport.ready,
      new Promise((_, r) => setTimeout(() => r(new Error("timed out after 10s")), 10000))
    ]);
    pass("QUIC/HTTP3 connection established");
  } catch (e) {
    fail("Connection", e.message);
    document.getElementById("runBtn").disabled = false;
    return;
  }

  // 2. Connection info
  log("\n--- Connection Info ---");
  try {
    info("Max datagram size: " + (transport.datagrams.maxDatagramSize || "unknown"));
    info("Congestion control: " + (transport.congestionControl || "not exposed"));
    info("Protocol: QUIC + HTTP/3 + WebTransport");
  } catch (e) {}

  // 3. Datagram echo
  log("\n--- Datagram Echo Test ---");
  try {
    const writer = transport.datagrams.writable.getWriter();
    const reader = transport.datagrams.readable.getReader();

    const testData = "datagram-echo-test-" + Date.now();
    const start = performance.now();
    await writer.write(new TextEncoder().encode(testData));
    writer.releaseLock();

    const { value } = await Promise.race([
      reader.read(),
      new Promise((_, r) => setTimeout(() => r(new Error("timed out after 5s")), 5000))
    ]);
    const rtt = (performance.now() - start).toFixed(1);
    const received = new TextDecoder().decode(value);
    reader.releaseLock();

    if (received === testData) {
      pass("Datagram echo (RTT: " + rtt + "ms)");
    } else {
      fail("Datagram echo", "data mismatch");
    }
  } catch (e) {
    fail("Datagram echo", e.message);
  }

  // 4. Datagram throughput
  log("\n--- Datagram Throughput (20 rapid sends) ---");
  try {
    const writer = transport.datagrams.writable.getWriter();
    const reader = transport.datagrams.readable.getReader();
    const sent = 20;

    for (let i = 0; i < sent; i++) {
      await writer.write(new TextEncoder().encode("dg-" + i));
    }
    writer.releaseLock();

    let received = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && received < sent) {
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise((_, r) => setTimeout(() => r(new Error("done")), Math.max(1, deadline - Date.now())))
        ]);
        if (!result.done) received++;
      } catch { break; }
    }
    reader.releaseLock();

    const pct = Math.round(received / sent * 100);
    if (pct >= 90) pass("Datagram delivery: " + received + "/" + sent + " (" + pct + "%)");
    else if (pct >= 50) log("  WARN  Datagram delivery: " + received + "/" + sent + " (" + pct + "%) — some loss", "warn");
    else fail("Datagram delivery", received + "/" + sent + " (" + pct + "%) — high loss");
  } catch (e) {
    fail("Datagram throughput", e.message);
  }

  // 5. Bidi stream echo
  log("\n--- Bidirectional Stream Test ---");
  try {
    const stream = await transport.createBidirectionalStream();
    pass("Bidi stream created");

    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();

    const testMsg = "bidi-stream-echo-test";
    const start = performance.now();
    await writer.write(new TextEncoder().encode(testMsg));
    pass("Bidi stream write");

    const { value } = await Promise.race([
      reader.read(),
      new Promise((_, r) => setTimeout(() => r(new Error("timed out after 5s — server may not be echoing on streams")), 5000))
    ]);
    const rtt = (performance.now() - start).toFixed(1);
    const received = new TextDecoder().decode(value);

    if (received === testMsg) {
      pass("Bidi stream echo (RTT: " + rtt + "ms)");
    } else {
      fail("Bidi stream echo", "data mismatch: got '" + received + "'");
    }
    await writer.close();
    pass("Bidi stream close");
  } catch (e) {
    fail("Bidi stream", e.message);
  }

  // 6. Multiple bidi streams
  log("\n--- Multiple Streams (5 concurrent) ---");
  try {
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push((async () => {
        const stream = await transport.createBidirectionalStream();
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();
        const msg = "multi-" + i;
        await writer.write(new TextEncoder().encode(msg));
        const { value } = await Promise.race([
          reader.read(),
          new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 5000))
        ]);
        const got = new TextDecoder().decode(value);
        await writer.close();
        return got === msg;
      })());
    }
    const results = await Promise.all(promises);
    const ok = results.filter(Boolean).length;
    if (ok === 5) pass("5/5 concurrent streams echoed correctly");
    else fail("Concurrent streams", ok + "/5 succeeded");
  } catch (e) {
    fail("Concurrent streams", e.message);
  }

  // 7. Unidirectional stream
  log("\n--- Unidirectional Stream Test ---");
  try {
    const stream = await transport.createUnidirectionalStream();
    const writer = stream.getWriter();
    await writer.write(new TextEncoder().encode("uni test"));
    await writer.close();
    pass("Uni stream send (fire-and-forget)");
  } catch (e) {
    fail("Uni stream", e.message);
  }

  // 8. Latency stats
  log("\n--- Latency Test (10 pings) ---");
  try {
    const rtts = [];
    for (let i = 0; i < 10; i++) {
      const writer = transport.datagrams.writable.getWriter();
      const reader = transport.datagrams.readable.getReader();
      const start = performance.now();
      await writer.write(new TextEncoder().encode("p" + i));
      writer.releaseLock();
      await Promise.race([
        reader.read(),
        new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 3000))
      ]);
      reader.releaseLock();
      rtts.push(performance.now() - start);
    }
    const min = Math.min(...rtts).toFixed(1);
    const max = Math.max(...rtts).toFixed(1);
    const avg = (rtts.reduce((a,b) => a+b, 0) / rtts.length).toFixed(1);
    const p95 = rtts.sort((a,b) => a-b)[Math.floor(rtts.length * 0.95)].toFixed(1);
    info("Min: " + min + "ms  Avg: " + avg + "ms  P95: " + p95 + "ms  Max: " + max + "ms");
    if (parseFloat(avg) < 100) pass("Latency acceptable for real-time gaming");
    else log("  WARN  Latency may be too high for fast-paced games", "warn");
  } catch (e) {
    fail("Latency test", e.message);
  }

  transport.close();
  log("\n=== Done ===");
  document.getElementById("runBtn").disabled = false;
}
</script>
</body>
</html>`
