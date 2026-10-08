// Local control center for the Burrow host: a small web page on 127.0.0.1 that shows
// the code, Ollama status and live activity. Only reachable from this PC.

const http = require("http");
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "control.html");

// The panel's port doubles as a lock: if it's taken, another Burrow host is already running (onBusy).
function startPanel({ port, getState, actions, files, load, onListening, onBusy }) {
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
    // Loading progress for the website on this PC (only a model name and a percentage, so any page may read it).
    const lp = req.method === "GET" && req.url.match(/^\/load(?:\?model=([^&]*))?$/);
    if (lp && load) {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(load(lp[1] ? decodeURIComponent(lp[1]) : "")));
    }
    // Files: download one that arrived from a device, or add one for devices to download (see files.js).
    const dl = req.method === "GET" && req.url.match(/^\/received\/(.+)$/);
    if (dl && files) {
      const f = files.receivedPath(decodeURIComponent(dl[1]));
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f))}` });
      return fs.createReadStream(f).pipe(res);
    }
    const up = req.method === "POST" && req.url.match(/^\/upload\?name=(.+)$/);
    if (up && files && req.headers["x-burrow"] === "1") {
      files.saveToOutbox(decodeURIComponent(up[1]), req)
        .then((r) => { push(); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r)); })
        .catch((e) => { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
      return;
    }
    // Actions need a custom header, which other websites can't send without a CORS preflight we never allow.
    const m = req.method === "POST" && req.url.match(/^\/action\/([a-z-]+)$/);
    if (m && actions[m[1]] && req.headers["x-burrow"] === "1") {
      let raw = "";
      req.on("data", (c) => { raw += c; if (raw.length > 10000) req.destroy(); });
      req.on("end", () => Promise.resolve()
        .then(() => { let b = {}; try { b = JSON.parse(raw || "{}"); } catch {} return actions[m[1]](b); })
        .then((r) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r || { ok: true })); })
        .catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }));
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
