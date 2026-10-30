// Local control center for the Burrow host: a small web page on 127.0.0.1 that shows
// the code, Ollama status and live activity. Only reachable from this PC.

const http = require("http");
const fs = require("fs");
const path = require("path");

const HTML = path.join(__dirname, "control.html");

// The panel's port doubles as a lock: if it's taken, another Burrow host is already running (onBusy).
// Websites allowed to use the local doorway to Ollama (/ollama/...): the Albatross pages and this PC.
const ORIGINS = /^https:\/\/(albatrossassistent\.github\.io|burrowgeneral\.github\.io|burrow-uu7e\.onrender\.com)$|^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function startPanel({ port, getState, actions, files, load, proxy, jarvis, code, chats, jobs, jobsStream, agent, browser, browserStream, monitor, onListening, onBusy }) {
  const clients = new Set();

  const server = http.createServer((req, res) => {
    // Block other hostnames (DNS rebinding) so only pages on this PC can talk to the panel.
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") { res.writeHead(403); return res.end(); }

    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return fs.createReadStream(HTML).pipe(res);
    }
    // The Monitor's full-screen window on this PC (see monitor.js)
    if (monitor && /^\/monitor(\/|\?|$)/.test(req.url) && monitor.serve(req, res)) return;
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify(getState())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    // The website on this PC talks to Ollama through here, so it also gets ComfyUI image models,
    // one-model-at-a-time and the loading percentage, just like devices that connect with the code.
    // Jarvis, for the website on this PC (devices with the code reach it end-to-end encrypted instead).
    const jx = req.url.match(/^(\/(?:jarvis|pc)\/[a-z]+(?:\?[\w=&.%-]*)?)$/);
    if (jx && jarvis) {
      const origin = req.headers.origin || "";
      if (origin && !ORIGINS.test(origin)) { res.writeHead(403); return res.end(); }
      const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" });
        return res.end();
      }
      let body = "";
      // the Monitor takes pictures and videos from the device in pieces of a few MB
      const max = jx[1] === "/pc/monitor" ? 12e6 : 1e5;
      req.on("data", (c) => { body += c; if (body.length > max) req.destroy(); });
      req.on("end", async () => {
        let status = 500, out = {};
        try { [status, out] = await jarvis(req.method, jx[1], body); } catch (e) { status = e.status || 500; out = { error: e.message }; }
        res.writeHead(status, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    // The Code tool (see code.js): projects written by the website's AI on this PC. Bigger bodies than Jarvis, so its own route.
    const cx = req.url.match(/^(\/code\/(?:write|read|projects))$/);
    if (cx && code) {
      const origin = req.headers.origin || "";
      if (origin && !ORIGINS.test(origin)) { res.writeHead(403); return res.end(); }
      const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" });
        return res.end();
      }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 8e6) req.destroy(); });
      req.on("end", () => {
        let status = 500, out = {};
        try { [status, out] = code(req.method, cx[1], body); } catch (e) { out = { error: e.message }; }
        res.writeHead(status, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    // Chats saved on this PC (see chats.js), for the website on this PC.
    const hx = req.url.match(/^(\/chats\/(?:list|get|put|delete))$/);
    if (hx && chats) {
      const origin = req.headers.origin || "";
      if (origin && !ORIGINS.test(origin)) { res.writeHead(403); return res.end(); }
      const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" });
        return res.end();
      }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 64e6) req.destroy(); });
      req.on("end", async () => {
        let status = 500, out = {};
        try { [status, out] = await chats(req.method, hx[1], body); } catch (e) { status = e.status || 500; out = { error: e.message }; }
        res.writeHead(status, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    // The browser on this PC (see browser.js), for the website on this PC.
    const bx = req.url.match(/^(\/browser\/(?:start|viewport|state|input|nav|tab|dialog|stop|stream|open|read|act|private|clearhistory))$/);
    if (bx && browser) {
      const origin = req.headers.origin || "";
      if (origin && !ORIGINS.test(origin)) { res.writeHead(403); return res.end(); }
      const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" });
        return res.end();
      }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on("end", async () => {
        if (bx[1] === "/browser/stream" && browserStream) {
          const ac = new AbortController(); res.on("close", () => ac.abort());
          res.writeHead(200, { ...cors, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
          try { await browserStream(body, (t) => res.write(t), ac.signal, () => res.writableLength > 1.5e6); } catch (e) { try { res.write(JSON.stringify({ error: e.message }) + "\n"); } catch {} }
          return res.end();
        }
        let status = 500, out = {};
        try { [status, out] = await browser(req.method, bx[1], body); } catch (e) { out = { error: e.message }; }
        res.writeHead(status, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    // PC files and the Agent's tools (see agent.js and mail.js), for the website on this PC.
    const ax = req.url.match(/^(\/(?:pcfiles|agent)\/[a-z]+(?:\/[a-z]+)?)$/);
    if (ax && agent) {
      const origin = req.headers.origin || "";
      if (origin && !ORIGINS.test(origin)) { res.writeHead(403); return res.end(); }
      const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" });
        return res.end();
      }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 12e6) req.destroy(); });
      req.on("end", async () => {
        let status = 500, out = {};
        try { [status, out] = await agent(req.method, ax[1], body); } catch (e) { out = { error: e.message }; }
        res.writeHead(status, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    // Chat requests that keep running on this PC (see jobs.js), for the website on this PC.
    const kx = req.url.match(/^(\/jobs\/(?:start|poll|cancel|list|stream))$/);
    if (kx && jobs) {
      const origin = req.headers.origin || "";
      if (origin && !ORIGINS.test(origin)) { res.writeHead(403); return res.end(); }
      const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" });
        return res.end();
      }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 64e6) req.destroy(); });
      req.on("end", async () => {
        if (kx[1] === "/jobs/stream" && jobsStream) {
          const ac = new AbortController(); res.on("close", () => ac.abort());
          res.writeHead(200, { ...cors, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
          try { await jobsStream(body, (t) => res.write(t), ac.signal); } catch {}
          return res.end();
        }
        let status = 500, out = {};
        try { [status, out] = await jobs(req.method, kx[1], body); } catch (e) { status = e.status || 500; out = { error: e.message }; }
        res.writeHead(status, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    const px = req.url.match(/^\/ollama(\/api\/[a-z]+)$/);
    if (px && proxy) {
      const origin = req.headers.origin || "";
      if (origin && !ORIGINS.test(origin)) { res.writeHead(403); return res.end(); }
      const cors = origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" });
        return res.end();
      }
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 80e6) req.destroy(); });
      req.on("end", async () => {
        const ac = new AbortController();
        res.on("close", () => { if (!res.writableEnded) ac.abort(); });
        try {
          const r = await proxy(req.method, px[1], req.method === "POST" ? body : undefined, ac.signal);
          res.writeHead(r.status, { ...cors, "Content-Type": r.headers.get("content-type") || "application/json", "Cache-Control": "no-store" });
          if (!r.body) return res.end();
          const reader = r.body.getReader();
          for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
          res.end();
        } catch (e) {
          if (!res.headersSent) { res.writeHead(502, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
          else res.end();
        }
      });
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
