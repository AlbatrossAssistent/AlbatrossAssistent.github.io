// Local control center for the Burrow host: a small web page on 127.0.0.1 that shows
// the code, Ollama status and live activity. Only reachable from this PC.

const http = require("http");
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "control.html");

// The panel's port doubles as a lock: if it's taken, another Burrow host is already running (onBusy).
function startPanel({ port, getState, actions, onListening, onBusy }) {
  const clients = new Set();

  const server = http.createServer((req, res) => {
    // Block other hostnames (DNS rebinding) so only pages on this PC can talk to the panel.
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") { res.writeHead(403); return res.end(); }

    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return fs.createReadStream(HTML).pipe(res);
    }
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(getState())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    // Actions need a custom header, which other websites can't send without a CORS preflight we never allow.
    const m = req.method === "POST" && req.url.match(/^\/action\/([a-z-]+)$/);
    if (m && actions[m[1]] && req.headers["x-burrow"] === "1") {
      Promise.resolve()
        .then(() => actions[m[1]]())
        .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r || { ok: true })); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
      return;
    }
    res.writeHead(404); res.end();
  });

  let timer = 0;
  const push = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      const data = `data: ${JSON.stringify(getState())}\n\n`;
      for (const c of clients) c.write(data);
    }, 100);
  };
  setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 20000).unref();

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") return onBusy(`http://127.0.0.1:${port}/`);
    console.log("  Control center couldn't start:", e.message);
  });
  server.on("listening", () => onListening(`http://127.0.0.1:${port}/`));
  server.listen(port, "127.0.0.1");

  return { push };
}

module.exports = { startPanel };
