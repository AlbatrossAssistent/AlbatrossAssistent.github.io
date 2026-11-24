// Builds the website's extra pages and search/share data: the guides (guides/*.html), the contact page, sitemap.xml, robots.txt,
// and the <head> block (canonical link, description, share image, structured data) of every public page.
//   node tools/site.js          (run again after changing a guide below; the head blocks are replaced between the SEO markers)
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const SITE = "https://albatrossassistent.github.io/";
const REPO = "https://github.com/AlbatrossAssistent/AlbatrossAssistent.github.io";
const ISSUES = REPO + "/issues";
const DOWNLOAD = REPO + "/releases/latest";
const TODAY = "2026-11-24";
const OG = SITE + "og.png";
const MARK = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8").match(/<path fill-rule="evenodd" d="(M14 2a12[^"]+)"/)[1];
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const ORG = { "@type": "Organization", "@id": SITE + "#org", name: "Albatross", url: SITE, logo: SITE + "public/icon-512.png", sameAs: [REPO],
  contactPoint: { "@type": "ContactPoint", contactType: "customer support", url: ISSUES, availableLanguage: ["English", "German"] } };

// ---------- the <head> block: canonical, description, Open Graph / Twitter card, structured data ----------
function head({ url, title, description, type = "website", ld = [] }) {
  const graph = { "@context": "https://schema.org", "@graph": [ORG, ...ld] };
  return `<!-- SEO (tools/site.js) -->
<link rel="canonical" href="${url}">
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="Albatross">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${OG}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Albatross: your own AI, on your own PC">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${OG}">
<link rel="apple-touch-icon" href="${SITE}public/icon-180.png">
<script type="application/ld+json">${JSON.stringify(graph)}</script>
<!-- /SEO -->`;
}
function putHead(file, block) {
  const p = path.join(ROOT, file);
  let s = fs.readFileSync(p, "utf8");
  const crlf = s.includes("\r\n"); s = s.replace(/\r\n/g, "\n");
  s = s.replace(/<!-- SEO \(tools\/site\.js\) -->[\s\S]*?<!-- \/SEO -->\n?/, "");
  s = s.replace(/<meta name="description" content="[^"]*">\n?/, "");                 // the block brings its own
  s = s.replace(/(<title>[^<]*<\/title>\n)/, (m) => m + block + "\n");
  fs.writeFileSync(p, crlf ? s.replace(/\n/g, "\r\n") : s);
}
const crumbs = (items) => ({ "@type": "BreadcrumbList", itemListElement: items.map(([name, url], i) => ({ "@type": "ListItem", position: i + 1, name, item: url })) });

// ---------- the guides ----------
const GUIDES = [
  {
    slug: "set-up-your-own-ai", title: "How to set up your own private AI on a Windows PC",
    description: "Step by step: install Albatross, let it set up Ollama, download a first model and chat with an AI that runs entirely on your own computer.",
    body: `
<p class="lead">Albatross turns a Windows PC into your own AI server. The AI models run on your graphics card, your chats stay on your devices, and nothing is sent to an AI company. This guide takes you from nothing to your first answer in about fifteen minutes, most of which is the model download.</p>
<h2>What you need</h2>
<ul>
  <li>A Windows 10 or 11 PC. An NVIDIA graphics card with 8 GB of memory or more makes answers fast; without one, smaller models still work, just slower.</li>
  <li>Some free disk space: a typical model is 2 to 10 GB.</li>
  <li>An internet connection for the downloads. After that, chatting on the PC itself works offline.</li>
</ul>
<h2>1. Install the Windows app</h2>
<p>Download <a href="${DOWNLOAD}">the latest Albatross installer</a> from GitHub and run it. It installs for your user only, so it doesn't need admin rights, and puts Albatross in the Start menu and next to the clock.</p>
<p>On the first start, Albatross checks for <b>Ollama</b>, the free engine that runs the AI models. If it's missing, Albatross downloads and installs it by itself. Then it starts the <b>host</b>: the small background part that connects your devices, runs the models and does the work on the PC. The opening screen shows each step as it happens.</p>
<h2>2. Download a first model</h2>
<p>Open <b>Settings → Installed models</b>. Albatross suggests models that fit common graphics cards. Good first choices:</p>
<ul>
  <li><b>qwen3:14b</b>: very capable, for cards with about 12 GB of memory.</li>
  <li><b>qwen3:8b</b> or <b>llama3.1:8b</b>: for 8 GB cards.</li>
  <li><b>gemma3:4b</b>: small and quick, for weaker PCs and laptops.</li>
</ul>
<p>The download runs in the background with a progress bar. Models are stored by Ollama, not inside Albatross, so other Ollama apps can use them too. See <a href="choosing-a-model.html">choosing a model for your graphics card</a> for more detail.</p>
<h2>3. Start chatting</h2>
<p>Pick the model at the top of the chat and write your first message. Reasoning models show their thinking live while they work. Every chat can have its own instructions, and you can let a chat search the web when you want current information.</p>
<h2>4. Optional: start at boot</h2>
<p>Albatross starts with Windows by default and waits quietly in the tray. If you want your phone to reach the PC even before anyone signs in, turn on <b>Start at boot</b> on the <b>Host</b> page. Windows asks once for admin rights and your password, because the host then runs as a background task.</p>
<h2>Next steps</h2>
<ul>
  <li><a href="use-from-your-phone.html">Use your AI from your phone, anywhere</a></li>
  <li><a href="how-the-encryption-works.html">How Albatross keeps your chats private</a></li>
</ul>`,
  },
  {
    slug: "use-from-your-phone", title: "How to use your own AI from your phone, anywhere",
    description: "Connect your phone, tablet or laptop to the AI on your PC with a 16-character code, install it as an app, and turn the PC on remotely.",
    body: `
<p class="lead">Once the host runs on your PC, every other device can use its AI: your phone on the train, a laptop at a friend's, a tablet on the sofa. The connection is end-to-end encrypted with a code only your devices know.</p>
<h2>1. Get your PC's code</h2>
<p>Open the Albatross app on the PC and open the <b>Host</b> page or the control center. You'll see a 16-character code such as <code>K7QM-4XPT-9F2C-HW3D</code>. The first half finds your PC; the second half is the encryption key and never leaves your devices. Treat it like a password.</p>
<h2>2. Connect your phone</h2>
<p>Open <a href="${SITE}public/">albatrossassistent.github.io/public</a> on the phone, go to <b>Settings → Connection</b>, choose <b>Remote</b> and enter the code. The opening screen then shows your phone pinging the PC and the PC pinging Ollama; when both turn green you're connected, and the model list from your PC appears.</p>
<h2>3. Install it as an app</h2>
<p>For full screen and an icon on the home screen:</p>
<ul>
  <li><b>iPhone and iPad:</b> in Safari, tap Share → <i>Add to Home Screen</i>.</li>
  <li><b>Android:</b> in Chrome, tap the menu → <i>Install app</i>.</li>
</ul>
<h2>4. What works from the phone</h2>
<ul>
  <li>Chats with every model on your PC, including pictures made by your image models.</li>
  <li>Sending files to your PC and back (Beam), encrypted end to end.</li>
  <li>Watching and stopping Jarvis, the assistant that can use your PC for you.</li>
  <li>Long answers and pictures keep going on the PC if your phone loses its connection, and arrive when it's back.</li>
</ul>
<h2>When the PC is off</h2>
<p>Your AI needs the PC to be running. In <b>Settings → Connection → Turn your PC on and off</b> you can set up <b>Wake-on-LAN</b> (the Albatross server sends a wake-up signal through your router) or, under <i>Advanced</i>, a <b>smart plug link</b>. Albatross then switches the PC on for you, and the host starts sharing by itself once the PC is up. You can also let the PC sleep when nobody uses it.</p>
<h2>Letting others use your AI</h2>
<p>Only people with your code can connect. For friends and family there's a separate <b>guest code</b>: guests can chat and make pictures, but can't see your files, chats or settings. You can switch guests off at any time on the <b>Host</b> page (<i>Guests can connect</i>).</p>`,
  },
  {
    slug: "how-the-encryption-works", title: "How Albatross keeps your AI chats private",
    description: "Where your data goes when you use Albatross: what stays on your devices, what the relay server sees, and how the end-to-end encryption with your code works.",
    body: `
<p class="lead">Most AI chat apps send every message to a company's servers. Albatross runs the AI on your own PC, and everything between your devices is encrypted with a key only those devices have. This page explains exactly what that means.</p>
<h2>What stays with you</h2>
<ul>
  <li><b>The AI itself:</b> models run on your PC's graphics card through Ollama. Cloud AI models are blocked.</li>
  <li><b>Your chats and pictures:</b> saved in your browser and on your PC, not on a server.</li>
  <li><b>Your encryption key:</b> the second half of your 16-character code. It is never sent anywhere.</li>
</ul>
<h2>The relay server</h2>
<p>Your phone usually can't reach your PC directly, because home routers block incoming connections. So both connect out to a small relay server, which passes messages between them. The relay sees that a message goes to your PC, when and how big it is, and your IP address, but it can't read or change the content.</p>
<h2>How the encryption works</h2>
<p>Each request is sealed with <b>AES-GCM</b> using a key derived from the second half of your code. The PC answers in numbered, sealed pieces, so nothing can be dropped, swapped or added on the way without your device noticing. Because only your devices know the key, the relay just forwards data it cannot open. If you ever share your code by mistake, make a new one in the control center: the old code stops working at once.</p>
<h2>Accounts are optional</h2>
<p>You can use Albatross without signing in. If you sign in with Google or email, your settings sync between devices; your PC code and power link are only stored encrypted with a passphrase you choose, which nobody can recover for you.</p>
<h2>Open source</h2>
<p>All of this can be checked: the app, the host and the relay server are <a href="${REPO}">public on GitHub</a>. Details for lawyers are in the <a href="../privacy.html">privacy policy</a>.</p>`,
  },
  {
    slug: "choosing-a-model", title: "Choosing an AI model for your graphics card",
    description: "Which local AI model to run with Albatross and Ollama for your GPU: how graphics memory limits model size, and good picks for 4, 8, 12 and 16+ GB cards.",
    body: `
<p class="lead">Local models come in sizes, measured in billions of parameters (the "8b" or "14b" in their names). Bigger models answer better but need more graphics memory (VRAM). The trick is picking the largest model that still fits entirely on your card.</p>
<h2>Why graphics memory matters</h2>
<p>A model runs fast when all of it fits in your graphics card's memory. If it doesn't, Ollama moves part of it to the normal memory and the processor, and answers get many times slower. As a rough guide for the usual 4-bit versions Ollama downloads, a model needs a bit more than half a gigabyte of VRAM per billion parameters, plus some room for the conversation.</p>
<h2>Good picks by card</h2>
<ul>
  <li><b>No dedicated GPU or 4 GB:</b> models around 1 to 4 billion parameters, such as <code>gemma3:4b</code> or <code>qwen3:4b</code>. Fine for short answers and summaries.</li>
  <li><b>8 GB:</b> 7 to 8 billion parameters, such as <code>qwen3:8b</code> or <code>llama3.1:8b</code>. A big step up for writing and coding help.</li>
  <li><b>12 GB:</b> up to about 14 billion, such as <code>qwen3:14b</code>. The sweet spot for many people.</li>
  <li><b>16 GB and more:</b> 20 to 32 billion parameter models for the best quality at home.</li>
</ul>
<h2>Thinking models</h2>
<p>Some models think before they answer. Albatross shows the thinking live and lets you choose how hard a model should think. More thinking means better answers to hard questions, but a longer wait.</p>
<h2>One model at a time</h2>
<p>Albatross keeps one model in memory at a time and shows which one is loaded. Switching models takes a few seconds while the new one loads; the button <b>Free GPU memory</b> empties the card when you want it for a game.</p>
<h2>Pictures</h2>
<p>Image models run through ComfyUI next to Ollama. Albatross makes sure only one heavy model uses the card at once, so a picture and a chat model don't fight over memory.</p>
<p>Ready to try one? Follow <a href="set-up-your-own-ai.html">the setup guide</a>.</p>`,
  },
];

const NAV = (up) => `<nav class="nav"><a class="brand" href="${up}./"><svg viewBox="0 0 28 28"><path fill-rule="evenodd" d="${MARK}"/></svg>Albatross</a><span class="sp"></span><a href="${up}guides/">Guides</a><a href="${up}contact.html">Contact</a><a class="btn" href="${up}public/">Open app</a></nav>`;
const FOOT = (up) => `<footer class="foot"><span>© 2026 Albatross</span><span class="sp"></span><a href="${up}guides/">Guides</a><a href="${up}contact.html">Contact</a><a href="${up}terms.html">Terms of Use</a><a href="${up}privacy.html">Privacy Policy</a><a href="${up}./">Home</a></footer>`;
const page = ({ up, title, headBlock, main }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${headBlock}
<link rel="icon" href="${up}public/icon.svg">
<link rel="stylesheet" href="${up}legal.css">
</head>
<body>
${NAV(up)}
<main class="doc">
${main}
</main>
${FOOT(up)}
</body>
</html>
`;

fs.mkdirSync(path.join(ROOT, "guides"), { recursive: true });
for (const g of GUIDES) {
  const url = SITE + "guides/" + g.slug + ".html";
  const ld = [
    { "@type": "TechArticle", headline: g.title, description: g.description, url, mainEntityOfPage: url, image: OG, datePublished: TODAY, dateModified: TODAY, inLanguage: "en", author: { "@id": SITE + "#org" }, publisher: { "@id": SITE + "#org" } },
    crumbs([["Albatross", SITE], ["Guides", SITE + "guides/"], [g.title, url]]),
  ];
  const others = GUIDES.filter((o) => o !== g).map((o) => `<li><a href="${o.slug}.html">${esc(o.title)}</a></li>`).join("");
  fs.writeFileSync(path.join(ROOT, "guides", g.slug + ".html"), page({ up: "../", title: g.title + " — Albatross", headBlock: head({ url, title: g.title, description: g.description, type: "article", ld }),
    main: `<p class="meta"><a href="./">Guides</a> · Updated ${TODAY}</p>\n<h1>${esc(g.title)}</h1>\n${g.body.trim()}\n<h2>More guides</h2>\n<ul>${others}</ul>\n<p>Questions? <a href="../contact.html">Get in touch</a>.</p>` }));
}
{
  const url = SITE + "guides/";
  const list = GUIDES.map((g) => `<li><a href="${g.slug}.html"><b>${esc(g.title)}</b></a><br>${esc(g.description)}</li>`).join("\n");
  const ld = [{ "@type": "CollectionPage", name: "Albatross guides", url, hasPart: GUIDES.map((g) => ({ "@type": "TechArticle", headline: g.title, url: SITE + "guides/" + g.slug + ".html" })) }, crumbs([["Albatross", SITE], ["Guides", url]])];
  fs.writeFileSync(path.join(ROOT, "guides", "index.html"), page({ up: "../", title: "Guides — Albatross", headBlock: head({ url, title: "Albatross guides: run your own private AI", description: "Guides for running your own AI with Albatross: setup on Windows, using it from your phone, privacy and encryption, and picking a model for your graphics card.", ld }),
    main: `<h1>Guides</h1>\n<p class="meta">Everything you need to run your own private AI with Albatross.</p>\n<ul class="guides">\n${list}\n</ul>` }));
}
// ---------- contact ----------
{
  const url = SITE + "contact.html";
  const ld = [{ "@type": "ContactPage", name: "Contact Albatross", url, about: { "@id": SITE + "#org" } }, crumbs([["Albatross", SITE], ["Contact", url]])];
  fs.writeFileSync(path.join(ROOT, "contact.html"), page({ up: "", title: "Contact — Albatross", headBlock: head({ url, title: "Contact Albatross", description: "How to reach the Albatross team: questions, bug reports, privacy requests and security reports.", ld }),
    main: `<h1>Contact</h1>
<p class="meta">We read everything and answer in English or German.</p>
<p class="lead">Albatross is open source and developed in public. The fastest way to reach us is an issue on GitHub: you get an answer there, and others with the same question find it too.</p>
<h2>Questions and help</h2>
<p>Something not working, or not sure how to do something? <a href="${ISSUES}/new">Open an issue on GitHub</a> and describe what you tried. A screenshot of the opening screen (it shows which connection fails) helps a lot. Many answers are already in the <a href="guides/">guides</a>.</p>
<h2>Bug reports and ideas</h2>
<p>Report bugs and suggest features in the <a href="${ISSUES}">issue tracker</a>. Please include your Albatross version (Settings → bottom of the sidebar) and whether you use the website, the Windows app or the Chrome extension.</p>
<h2>Privacy requests</h2>
<p>Albatross stores almost nothing about you; most data can be deleted directly by you (see the <a href="privacy.html">privacy policy</a>). For anything else, open an issue. Never post your PC code, passwords or personal data in an issue.</p>
<h2>Security reports</h2>
<p>Found a vulnerability? Please don't post the details publicly. Use <a href="${REPO}/security/advisories/new">GitHub's private vulnerability report</a> so we can fix it first.</p>
<h2>Source code</h2>
<p>Everything Albatross does is public: <a href="${REPO}">github.com/AlbatrossAssistent</a>.</p>` }));
}
// ---------- the existing pages ----------
const FAQ = [...fs.readFileSync(path.join(ROOT, "index.html"), "utf8").matchAll(/<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => [m[1].replace(/<[^>]+>/g, "").trim(), m[2].replace(/<[^>]+>/g, "").trim()]);
putHead("index.html", head({ url: SITE, title: "Albatross — Your own AI, on your own PC",
  description: "Albatross is a free, open-source AI app that runs on your own PC. Chat, write, code and make pictures with local models from any device, end-to-end encrypted, no account needed.",
  ld: [
    { "@type": "WebSite", "@id": SITE + "#site", name: "Albatross", url: SITE, publisher: { "@id": SITE + "#org" }, inLanguage: "en" },
    { "@type": "SoftwareApplication", name: "Albatross", applicationCategory: "UtilitiesApplication", operatingSystem: "Windows, Android, iOS, Web", url: SITE, downloadUrl: DOWNLOAD, image: OG,
      description: "A private AI chat that runs on your own PC with Ollama. Use it from your phone, end-to-end encrypted.", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }, publisher: { "@id": SITE + "#org" } },
    ...(FAQ.length ? [{ "@type": "FAQPage", mainEntity: FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) }] : []),
  ] }));
putHead("privacy.html", head({ url: SITE + "privacy.html", title: "Privacy Policy — Albatross", description: "What data Albatross handles, where it goes, and your rights. The AI runs on your own PC and your chats are end-to-end encrypted.", ld: [crumbs([["Albatross", SITE], ["Privacy Policy", SITE + "privacy.html"]])] }));
putHead("terms.html", head({ url: SITE + "terms.html", title: "Terms of Use — Albatross", description: "The terms for using Albatross, the free open-source AI app that runs on your own PC.", ld: [crumbs([["Albatross", SITE], ["Terms of Use", SITE + "terms.html"]])] }));
// the app: its own canonical address (the same app is reachable with ?embed and #code links)
{
  const p = path.join(ROOT, "public/index.html"); let s = fs.readFileSync(p, "utf8");
  if (!s.includes('rel="canonical"')) { s = s.replace(/(<title>[^<]*<\/title>)/, `$1\n<link rel="canonical" href="${SITE}public/">`); fs.writeFileSync(p, s); }
}
// ---------- sitemap and robots ----------
const urls = [[SITE, "1.0"], [SITE + "guides/", "0.8"], ...GUIDES.map((g) => [SITE + "guides/" + g.slug + ".html", "0.7"]), [SITE + "contact.html", "0.5"], [SITE + "privacy.html", "0.3"], [SITE + "terms.html", "0.3"], [SITE + "public/", "0.6"]];
fs.writeFileSync(path.join(ROOT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(([u, p]) => `  <url><loc>${u}</loc><lastmod>${TODAY}</lastmod><priority>${p}</priority></url>`).join("\n")}\n</urlset>\n`);
fs.writeFileSync(path.join(ROOT, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`);
console.log("site: " + GUIDES.length + " guides, contact, sitemap (" + urls.length + " urls), robots, heads; FAQ entries: " + FAQ.length);
