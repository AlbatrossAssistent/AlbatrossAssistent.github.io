# Burrow: local AI chat for Ollama

Burrow is a web chat for the Ollama on your own PC. You can also use that PC's AI from any other device by entering a 16-character code. Everything between that device and your PC is end-to-end encrypted.

```
 Other device (phone, laptop)  ──HTTPS──▶  Your server (server.js)  ◀──WebSocket──  Your PC (host.js) ──▶ Ollama
```

Your PC connects out to the server, so you don't need any port forwarding on your router. Your chats are stored only in the browser, never on the server.

**Live:**
- Server: https://burrow-uu7e.onrender.com
- Web page: https://burrowgeneral.github.io/burrow/
- Repo: https://github.com/BurrowGeneral/burrow

## 1. Put it on a server

You need any server with Node.js 18 or newer, like a small VPS, a Raspberry Pi or Render/Railway/Fly.io.

```bash
npm install
npm start               # runs on port 8080 (set PORT=... to change)
```

Put it behind HTTPS, for example with Caddy: `caddy reverse-proxy --from your-domain.com --to localhost:8080`. Caddy handles certificates and WebSockets automatically.

## 2. Share your PC's AI

On the PC that has Ollama:

```bash
npm install
node host/host.js https://burrow-uu7e.onrender.com
```

It prints your code, e.g. `K7QM-4XPT-9F2C-HW3D`, plus a link. Keep that window open while you want to share.

- You get the same code every time. It's saved in `host/host-code.json`.
- Run `node host/host.js https://burrow-uu7e.onrender.com --new` to get a fresh code. The old code stops working.
- Press Ctrl+C to stop sharing.
- A **control center** window opens (http://127.0.0.1:4747, only reachable from this PC). It shows the code in big letters, whether the server and Ollama are running, which models are in GPU memory, and every incoming message live. Add `--no-panel` to skip it.
- On Windows the PC **won't go to sleep** while the host runs. No power settings are changed; it's a request that ends when the host stops. The screen can still turn off, and closing a laptop lid still sleeps it.
- `burrow-host.bat` starts Ollama if it isn't running, then starts the host.

### Start at boot (Windows)

Flip **Start at boot** in the control center, or double-click `autostart-on.bat`. Windows asks for admin rights and your account password (a Microsoft account's password, not your PIN). Windows Task Scheduler stores the password; Burrow never sees it. From the next restart, Ollama and Burrow start by themselves, even before you sign in. The PC stays locked; Burrow just runs in the background.

- Run `burrow-host.bat` once first, so Burrow knows your server.
- While Burrow runs in the background, `burrow-host.bat` just opens the control center.
- The log is in `host/background.log`.
- To turn it off, use the switch or `autostart-off.bat`.

## 3. Connect from another device

Open `https://burrow-uu7e.onrender.com` (or https://burrowgeneral.github.io/burrow/), go to **Connect with code**, enter the code and press **Connect**. Or open the link that host.js printed.

## Using it only on your own PC (no server)

Open `public/index.html` in your browser. It talks to `http://localhost:11434`. If it can't connect, run `setx OLLAMA_ORIGINS "*"` (Windows) and restart Ollama.

## Security

- **End-to-end encrypted.** The code has two halves. `K7QM-4XPT` tells the server which PC to connect to. `9F2C-HW3D` is an encryption key that never leaves the browser or your PC (in links it comes after `#`, which browsers never send to a server). Messages and answers are encrypted with AES-256-GCM, using a key made from it with PBKDF2 (600,000 rounds). The server only passes along data it can't read or change.
- Your PC only accepts encrypted requests, so knowing the first half isn't enough to use it. Each request can only be used once and expires after 10 minutes. Each piece of an answer is numbered, so a dropped, swapped or changed piece is detected.
- Anyone with the full code can chat with your PC's AI. Only share it with people you trust, and use `--new` to replace it.
- Open the website from GitHub Pages (https://burrowgeneral.github.io/burrow/) for the strongest protection. The page that does the encryption then doesn't come from the relay server.
- The relay only allows: list models, show model, chat, generate. It can't delete or download models.
- After 30 wrong codes, the server blocks that IP for 10 minutes.

## Thinking

Models that can reason, like `qwen3`, `deepseek-r1` and `gpt-oss`, show a live "Thinking…" panel that folds into "Thought for X seconds". Burrow detects which models support this automatically. You can switch it off in Settings → Chat.

## Web search

Click the **Search** button next to the message box. The AI then decides by itself when to search, and you'll see the search bar, its query and the results.

To set it up, get a free API key at https://ollama.com/settings/keys and start the server with it:

```bash
OLLAMA_API_KEY=your_key npm start          # Linux/Mac
set OLLAMA_API_KEY=your_key && npm start   # Windows (cmd)
```

- Search only works with models that support tools, like `qwen3`, `llama3.1`, `gpt-oss` and `mistral`.
- For long web pages, set Settings → Model → Context length to 16384 or higher.
- The key stays on the server and is never sent to the browser. Each IP can make up to 60 searches per 10 minutes.
- Search needs the Burrow server, so it doesn't work when you open `index.html` directly as a file.

## Image generation

Ollama can generate images with `x/z-image-turbo` and `x/flux2-klein` (`ollama pull x/z-image-turbo`). This was macOS-only at launch (January 2026), so check whether your Ollama version supports it on Windows/Linux. Image models show up automatically in **Image** mode.
