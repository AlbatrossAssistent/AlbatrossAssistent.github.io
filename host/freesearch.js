// Web search without a key or credits: DuckDuckGo's plain HTML results page, read like a browser would. Used when Ollama's web
// search isn't available (no key, or its credits are used up): by the server (server.js) and, more reliably, from the PC itself
// (host/agent.js /agent/search), because search sites sometimes refuse data-center addresses but not a home connection.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ent = (s) => String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ");
const strip = (h) => ent(String(h || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

async function search(query, max = 6) {
  query = String(query || "").trim().slice(0, 300);
  if (!query) throw new Error("Empty query");
  const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query), {
    headers: { "User-Agent": UA, "Accept-Language": "de-DE,de;q=0.9,en;q=0.8", Accept: "text/html" },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error("The free search answered " + r.status);
  const html = await r.text();
  const results = [];
  for (const chunk of html.split(/<div class="result results_links/).slice(1)) {
    if (/result--ad/.test(chunk.slice(0, 200))) continue;                       // ads
    const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    if (!a) continue;
    let url = ent(a[1]);
    const real = /[?&]uddg=([^&]+)/.exec(url);
    if (real) url = decodeURIComponent(real[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const snip = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(chunk);
    results.push({ title: strip(a[2]) || url, url, content: strip(snip && snip[1]).slice(0, 600) });
    if (results.length >= max) break;
  }
  if (!results.length && /anomaly|captcha|challenge/i.test(html)) throw new Error("The free search asked for a captcha");
  return results;
}

module.exports = { search };
