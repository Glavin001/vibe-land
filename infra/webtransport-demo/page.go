package main

const demoHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WebTransport Demo</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .container { max-width: 800px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 28px; margin-bottom: 8px; color: #f8fafc; }
  .subtitle { color: #94a3b8; margin-bottom: 24px; font-size: 14px; }
  .status-bar { display: flex; gap: 16px; align-items: center; padding: 12px 16px; background: #1e293b; border-radius: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .status-dot.connected { background: #22c55e; box-shadow: 0 0 8px #22c55e88; }
  .status-dot.disconnected { background: #ef4444; }
  .status-dot.connecting { background: #eab308; animation: pulse 1s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .status-text { font-size: 14px; }
  .stat { font-size: 13px; color: #94a3b8; }
  .stat span { color: #38bdf8; font-weight: 600; }
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  @media (max-width: 640px) { .panels { grid-template-columns: 1fr; } }
  .panel { background: #1e293b; border-radius: 8px; padding: 16px; }
  .panel h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 12px; }
  .chat-log { height: 300px; overflow-y: auto; border: 1px solid #334155; border-radius: 6px; padding: 12px; font-size: 14px; line-height: 1.6; background: #0f172a; }
  .chat-log .msg { margin-bottom: 4px; }
  .chat-log .msg.system { color: #64748b; font-style: italic; }
  .chat-log .msg.chat .name { color: #38bdf8; font-weight: 600; }
  .chat-log .msg.chat .text { color: #e2e8f0; }
  .chat-log .msg.self .name { color: #a78bfa; }
  .chat-log .msg.error { color: #f87171; }
  .chat-log .msg.pong { color: #22c55e; }
  .input-row { display: flex; gap: 8px; margin-top: 12px; }
  .input-row input { flex: 1; background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 10px 14px; color: #e2e8f0; font-size: 14px; outline: none; }
  .input-row input:focus { border-color: #38bdf8; }
  button { background: #2563eb; color: white; border: none; border-radius: 6px; padding: 10px 20px; font-size: 14px; cursor: pointer; font-weight: 500; }
  button:hover { background: #1d4ed8; }
  button:disabled { background: #334155; cursor: not-allowed; }
  button.secondary { background: #334155; }
  button.secondary:hover { background: #475569; }
  button.danger { background: #dc2626; }
  button.danger:hover { background: #b91c1c; }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .ping-results { margin-top: 12px; }
  .ping-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .ping-bar .bar { height: 6px; background: #22c55e; border-radius: 3px; transition: width 0.3s; }
  .ping-bar .label { font-size: 12px; color: #94a3b8; min-width: 60px; }
  .info { font-size: 12px; color: #64748b; margin-top: 16px; line-height: 1.6; }
  .protocol-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .protocol-badge.wt { background: #7c3aed33; color: #a78bfa; border: 1px solid #7c3aed55; }
  .protocol-badge.quic { background: #05966933; color: #34d399; border: 1px solid #05966955; }
</style>
</head>
<body>
<div class="container">
  <h1>WebTransport Demo</h1>
  <p class="subtitle">
    Real-time communication over <span class="protocol-badge quic">QUIC</span> + <span class="protocol-badge wt">WebTransport</span> — no WebSocket, no TCP
  </p>

  <div class="status-bar">
    <div>
      <span class="status-dot disconnected" id="statusDot"></span>
      <span class="status-text" id="statusText">Disconnected</span>
    </div>
    <div class="stat">Clients: <span id="clientCount">0</span></div>
    <div class="stat">Messages: <span id="msgCount">0</span></div>
    <div class="stat">Latency: <span id="latency">—</span></div>
    <div class="stat" id="clientId"></div>
  </div>

  <div class="panels">
    <div class="panel">
      <h2>Chat (via Datagrams)</h2>
      <div class="chat-log" id="chatLog"></div>
      <div class="input-row">
        <input type="text" id="chatInput" placeholder="Type a message..." disabled />
        <button id="sendBtn" disabled>Send</button>
      </div>
    </div>

    <div class="panel">
      <h2>Latency (via Datagrams)</h2>
      <div class="chat-log" id="pingLog"></div>
      <div class="actions">
        <button id="pingBtn" class="secondary" disabled>Ping Server</button>
        <button id="ping10Btn" class="secondary" disabled>10x Ping</button>
      </div>
      <div class="ping-results" id="pingResults"></div>
    </div>
  </div>

  <div class="actions">
    <button id="connectBtn">Connect</button>
    <button id="disconnectBtn" class="danger" disabled>Disconnect</button>
  </div>

  <div class="info">
    This page is served over regular <b>HTTPS (TCP)</b>. Chat and pings use <b>WebTransport datagrams (UDP/QUIC)</b>.<br>
    Open this page in two browser tabs to see messages appear in real-time across both.<br>
    Datagrams are <b>unreliable</b> (like UDP) — occasional messages may be lost, but latency is minimal.
  </div>
</div>

<script>
const WT_URL = window.location.origin.replace("http://", "https://") + "/wt";
let transport = null;
let dgWriter = null;
let dgReader = null;
let msgCount = 0;
let myId = null;

const $ = (id) => document.getElementById(id);

function addChat(html, cls = "") {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  el.innerHTML = html;
  $("chatLog").appendChild(el);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}

function addPing(html, cls = "") {
  const el = document.createElement("div");
  el.className = "msg " + cls;
  el.innerHTML = html;
  $("pingLog").appendChild(el);
  $("pingLog").scrollTop = $("pingLog").scrollHeight;
}

function setStatus(state, text) {
  $("statusDot").className = "status-dot " + state;
  $("statusText").textContent = text;
}

async function connect() {
  if (transport) return;
  setStatus("connecting", "Connecting...");
  $("connectBtn").disabled = true;

  try {
    transport = new WebTransport(WT_URL);
    await transport.ready;
    setStatus("connected", "Connected");
    $("disconnectBtn").disabled = false;
    $("chatInput").disabled = false;
    $("sendBtn").disabled = false;
    $("pingBtn").disabled = false;
    $("ping10Btn").disabled = false;
    addChat("Connected to server", "system");

    transport.closed.then(() => {
      handleDisconnect("Connection closed");
    }).catch((err) => {
      handleDisconnect("Connection error: " + err.message);
    });

    // Listen for datagrams (broadcast messages + pong)
    listenDatagrams();

  } catch (err) {
    setStatus("disconnected", "Failed");
    addChat("Failed to connect: " + err.message, "error");
    $("connectBtn").disabled = false;
    transport = null;
  }
}

async function listenDatagrams() {
  try {
    const reader = transport.datagrams.readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const msg = JSON.parse(new TextDecoder().decode(value));
      handleMessage(msg);
    }
  } catch (e) {
    // transport closed
  }
}

function handleMessage(msg) {
  if (msg.type === "chat") {
    msgCount++;
    $("msgCount").textContent = msgCount;
    const isSelf = msg.from === myId;
    addChat('<span class="name">' + msg.from + ':</span> <span class="text">' + escapeHtml(msg.text) + '</span>',
            "chat" + (isSelf ? " self" : ""));
  } else if (msg.type === "system") {
    addChat(msg.text, "system");
    if (msg.clients) $("clientCount").textContent = msg.clients;
    // Try to figure out our ID from join messages
    if (msg.text.endsWith("joined") && !myId) {
      myId = msg.text.replace(" joined", "");
      $("clientId").innerHTML = 'You: <span>' + myId + '</span>';
    }
  } else if (msg.type === "pong") {
    const now = Date.now();
    const sent = pendingPings.shift();
    if (sent) {
      const rtt = now - sent;
      $("latency").textContent = rtt + "ms";
      addPing("Pong! RTT: " + rtt + "ms", "pong");
      pingHistory.push(rtt);
      if (pingHistory.length > 10) pingHistory.shift();
      renderPingBars();
    }
  }
}

let pendingPings = [];
let pingHistory = [];

async function sendPing() {
  if (!transport) return;
  try {
    const writer = transport.datagrams.writable.getWriter();
    const now = Date.now();
    pendingPings.push(now);
    const msg = JSON.stringify({ type: "ping", timestamp: now });
    await writer.write(new TextEncoder().encode(msg));
    writer.releaseLock();
    addPing("Ping sent...", "system");
  } catch (e) {
    addPing("Ping failed: " + e.message, "error");
  }
}

async function sendPing10() {
  for (let i = 0; i < 10; i++) {
    await sendPing();
    await new Promise(r => setTimeout(r, 100));
  }
}

function renderPingBars() {
  const max = Math.max(...pingHistory, 1);
  let html = "";
  pingHistory.forEach((rtt, i) => {
    const pct = Math.min((rtt / Math.max(max, 10)) * 100, 100);
    const color = rtt < 20 ? "#22c55e" : rtt < 50 ? "#eab308" : "#ef4444";
    html += '<div class="ping-bar"><span class="label">' + rtt + 'ms</span><div class="bar" style="width:' + pct + '%;background:' + color + '"></div></div>';
  });
  $("pingResults").innerHTML = html;
}

async function sendChat() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text || !transport) return;
  input.value = "";

  try {
    const writer = transport.datagrams.writable.getWriter();
    const msg = JSON.stringify({ type: "chat", text: text });
    await writer.write(new TextEncoder().encode(msg));
    writer.releaseLock();
  } catch (e) {
    addChat("Send failed: " + e.message, "error");
  }
}

function handleDisconnect(reason) {
  setStatus("disconnected", "Disconnected");
  addChat(reason, "system");
  $("connectBtn").disabled = false;
  $("disconnectBtn").disabled = true;
  $("chatInput").disabled = true;
  $("sendBtn").disabled = true;
  $("pingBtn").disabled = true;
  $("ping10Btn").disabled = true;
  transport = null;
  myId = null;
}

function disconnect() {
  if (transport) {
    transport.close();
    transport = null;
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Event listeners
$("connectBtn").addEventListener("click", connect);
$("disconnectBtn").addEventListener("click", disconnect);
$("sendBtn").addEventListener("click", sendChat);
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});
$("pingBtn").addEventListener("click", sendPing);
$("ping10Btn").addEventListener("click", sendPing10);

// Check WebTransport support
if (typeof WebTransport === "undefined") {
  setStatus("disconnected", "Not Supported");
  addChat("Your browser does not support WebTransport. Please use Chrome or Edge.", "error");
  $("connectBtn").disabled = true;
} else {
  addChat("WebTransport is supported. Click Connect to start.", "system");
}
</script>
</body>
</html>`
