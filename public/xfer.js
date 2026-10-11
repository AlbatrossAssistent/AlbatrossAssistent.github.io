// Sending files to your PC that can carry on without the page: unfinished files are kept in the browser's
// storage, the PC remembers how far each one got, and both the page and the service worker (sw.js) can
// continue them. Everything stays end-to-end encrypted with the code, exactly like chats (see index.html).
(function (g) {
  const te = new TextEncoder();
  const CHUNK = 4 * 1024 * 1024;

  // ---- storage: unfinished files and the (non-extractable) encryption keys, so the worker can use them too ----
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open("albatross-xfers", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("uploads", { keyPath: "tid" }); r.result.createObjectStore("keys"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode); const req = fn(t.objectStore(store));
      t.oncomplete = () => { db.close(); res(req && req.result); };
      t.onerror = t.onabort = () => { db.close(); rej(t.error); };
    });
  }
  const put = (rec) => tx("uploads", "readwrite", (s) => s.put(rec));
  const get = (tid) => tx("uploads", "readonly", (s) => s.get(tid));
  const del = (tid) => tx("uploads", "readwrite", (s) => s.delete(tid));
  const all = () => tx("uploads", "readonly", (s) => s.getAll()).then((x) => x || []);
  const putKey = (route, key) => tx("keys", "readwrite", (s) => s.put(key, route));
  const getKey = (route) => tx("keys", "readonly", (s) => s.get(route));

  // ---- one encrypted request to the PC (same envelope as e2eFetch in index.html) ----
  const toB64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); };
  const fromB64 = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  async function seal(key, text, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(aad) }, key, te.encode(text)));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return toB64(out);
  }
  async function unseal(key, b64, aad) {
    const b = fromB64(b64);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12), additionalData: te.encode(aad) }, key, b.subarray(12)));
  }
  // Returns { status, json }. Throws only when the connection itself fails.
  async function call(base, key, path, body, signal) {
    const id = crypto.randomUUID();
    const envelope = await seal(key, JSON.stringify({ id, t: Date.now(), method: "POST", path, body: JSON.stringify(body) }), "req");
    const res = await fetch(base + "/e2e", { method: "POST", headers: { "Content-Type": "text/plain" }, body: envelope, signal });
    if (!res.ok) { const e = await res.json().catch(() => ({})); return { status: res.status, json: { error: e.error || "The PC didn't answer (HTTP " + res.status + ")" }, refused: true }; }
    let meta = null, data = "", seq = 0;
    for (const line of (await res.text()).split("\n")) {
      if (!line) continue;
      const f = JSON.parse(await unseal(key, line, id + ":" + seq++));
      if (f.k === "m") meta = f; else if (f.k === "d") data += f.d; else if (f.k === "x") throw new Error(f.error || "Device error");
    }
    if (!meta) throw new Error("The connection to the device was cut off");
    let json = {}; try { json = JSON.parse(data); } catch {}
    return { status: meta.s, json };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const NETWORK = "network";

  // Sends (or continues) one file. rec = { tid, name, size, file, base, route }.
  // o = { key, signal, cancelled(), onProgress(got, size) }. Resolves with the saved file name.
  async function upload(rec, o = {}) {
    const key = o.key || await getKey(rec.route);
    if (!key) throw new Error("The code isn't available here anymore. Open Albatross and send the file again.");
    const gone = async () => o.cancelled?.() || (o.checkRecord !== false && !(await get(rec.tid).catch(() => rec)));
    // Ask the PC where it stopped (a retry after a break comes back here).
    const start = async () => {
      for (let n = 0; ; n++) {
        try {
          const r = await call(rec.base, key, "/files/upload-start", { tid: rec.tid, name: rec.name, size: rec.size }, o.signal);
          if (r.status !== 200) throw Object.assign(new Error(r.json.error || "HTTP " + r.status), { fatal: !r.refused });
          return r.json;
        } catch (e) { if (e.fatal || n >= 5 || o.signal?.aborted) throw e; await sleep(1000 * 2 ** n); }
      }
    };
    let s = await start();
    if (s.done) return s.saved;
    let off = s.got || 0;
    o.onProgress?.(off, rec.size);
    while (off < rec.size) {
      if (await gone()) throw Object.assign(new Error("Cancelled"), { cancelled: true });
      const buf = new Uint8Array(await rec.file.slice(off, off + CHUNK).arrayBuffer());
      let sent = false;
      for (let n = 0; !sent; n++) {
        try {
          const r = await call(rec.base, key, "/files/upload-chunk", { id: s.id, offset: off, data: toB64(buf) }, o.signal);
          if (r.status === 200) { off = r.json.got; sent = true; }
          else if (r.status === 409) { off = r.json.got; sent = true; }          // the PC already has more: continue from there
          else if (r.status === 404) { s = await start(); if (s.done) return s.saved; off = s.got || 0; sent = true; }
          else throw Object.assign(new Error(r.json.error || "HTTP " + r.status), { fatal: !r.refused });
        } catch (e) {
          if (e.fatal || e.cancelled || o.signal?.aborted || n >= 5) throw e;
          await sleep(1000 * 2 ** n);
          s = await start(); off = s.got || 0; sent = true; if (s.done) return s.saved;  // see how far the PC really got
        }
      }
      o.onProgress?.(off, rec.size);
    }
    for (let n = 0; ; n++) {
      try {
        const r = await call(rec.base, key, "/files/upload-end", { id: s.id }, o.signal);
        if (r.status === 200) return r.json.saved;
        throw Object.assign(new Error(r.json.error || "HTTP " + r.status), { fatal: !r.refused });
      } catch (e) { if (e.fatal || n >= 5 || o.signal?.aborted) throw e; await sleep(1000 * 2 ** n); }
    }
  }

  // Runs every unfinished file nobody else is working on. A file the page is sending holds a lock with the
  // file's id, so the worker leaves it alone until the page is closed (then it takes over).
  async function runPending(o = {}) {
    const rounds = o.rounds || 1;
    for (let round = 0; round < rounds; round++) {
      let skipped = 0, failed = 0;
      for (const rec of await all()) {
        if (!rec.file) { await del(rec.tid); continue; }
        const ran = await navigator.locks.request("albatross-up-" + rec.tid, { ifAvailable: true }, async (lock) => {
          if (!lock) return false;
          try { await upload(rec); await del(rec.tid); }
          catch (e) { if (e.cancelled) await del(rec.tid).catch(() => {}); else failed++; }
          return true;
        });
        if (!ran) skipped++;
      }
      if (!skipped && !failed) return true;
      if (round + 1 < rounds) await sleep(o.wait || 3000);
    }
    return false;
  }

  g.AlbatrossXfer = { CHUNK, put, get, del, all, putKey, getKey, upload, runPending };
})(typeof self !== "undefined" ? self : this);
