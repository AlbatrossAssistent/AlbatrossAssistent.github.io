# Albatross: local AI chat for Ollama

Albatross is a web chat for the Ollama on your own PC. You can also use that PC's AI from any other device by entering a 16-character code. Everything between that device and your PC is end-to-end encrypted.

```
 Other device (phone, laptop)  ──HTTPS──▶  Your server (server.js)  ◀──WebSocket──  Your PC (host.js) ──▶ Ollama
```

Your PC connects out to the server, so you don't need any port forwarding on your router. Your chats are stored only in the browser, never on the server.

**Live:**
- Server: https://burrow-uu7e.onrender.com
- Web page: https://albatrossassistent.github.io/
- Repo: https://github.com/AlbatrossAssistent/AlbatrossAssistent.github.io

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

### Turn the PC on from the website (smart plug + Alexa)

When your PC is off, the website can show a **Turn on PC** button. It opens your own turn-on link, which switches the PC's smart plug on (for example through an Alexa routine). The PC boots by itself when it gets power, and Albatross starts at boot.

1. **PC:** in the BIOS/UEFI, set *Restore on AC power loss* (sometimes called *AC Back* or *Power On after power failure*) to **Power On**. Plug the PC into a smart plug.
2. **Link:** create a routine that turns the plug **on** (only on, never off), started by a URL trigger from a service like [Voice Monkey](https://voicemonkey.io) or [Virtual Smart Home](https://www.virtualsmarthome.xyz). The service gives you a secret https link.
3. **Website:** paste that link in **Settings → Connection → Turn-on link**. It's saved on that device, and in your account encrypted with your passphrase if you're signed in. It never goes to the Albatross server.
4. Turn on **Start at boot** (above), so Albatross comes online after the PC boots.

When the PC is offline, press **Turn on PC** under the connection status. The page connects by itself once the PC is up, usually within 1 to 2 minutes.

- The button only shows while the PC is offline, so it never touches a running PC.
- Treat the link like a password: anyone who has it can switch the plug on.
- After you shut the PC down, switch the plug off (for example "Alexa, turn off PC plug"), so turning it on next time actually gives it power.

## 3. Connect from another device

Open `https://burrow-uu7e.onrender.com` (or https://albatrossassistent.github.io/), go to **Connect with code**, enter the code and press **Connect**. Or open the link that host.js printed.

## Using it only on your own PC (no server)

Open `public/index.html` in your browser. It talks to `http://localhost:11434`. If it can't connect, run `setx OLLAMA_ORIGINS "*"` (Windows) and restart Ollama.

## Security

- **End-to-end encrypted.** The code has two halves. `K7QM-4XPT` tells the server which PC to connect to. `9F2C-HW3D` is an encryption key that never leaves the browser or your PC (in links it comes after `#`, which browsers never send to a server). Messages and answers are encrypted with AES-256-GCM, using a key made from it with PBKDF2 (600,000 rounds). The server only passes along data it can't read or change.
- Your PC only accepts encrypted requests, so knowing the first half isn't enough to use it. Each request can only be used once and expires after 10 minutes. Each piece of an answer is numbered, so a dropped, swapped or changed piece is detected.
- Anyone with the full code can chat with your PC's AI. Only share it with people you trust, and use `--new` to replace it.
- Open the website from GitHub Pages (https://albatrossassistent.github.io/) for the strongest protection. The page that does the encryption then doesn't come from the relay server.
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

**On macOS**, Ollama can make images itself: `ollama pull x/z-image-turbo` (or `x/flux2-klein`). Image models show up automatically in **Image** mode.

**On Windows (and Linux)**, Ollama can't make images yet, so the Burrow host uses [ComfyUI](https://github.com/Comfy-Org/ComfyUI) instead:

1. Download `ComfyUI_windows_portable_nvidia.7z` from the [ComfyUI releases](https://github.com/Comfy-Org/ComfyUI/releases) and unpack it into a `ComfyUI` folder next to the Burrow folder (for example `C:\Burrow\app` and `C:\Burrow\ComfyUI\ComfyUI_windows_portable`). Set `COMFY_DIR` if you put it somewhere else.
2. From [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo/tree/main/split_files), put these into `ComfyUI\models`:
   - `diffusion_models/z_image_turbo_nvfp4.safetensors` (4.5 GB, for RTX 50-series; use `z_image_turbo_int8_convrot.safetensors` on older cards and change its file name in `MODELS` in `host/comfy.js`)
   - `text_encoders/qwen_3_4b_fp8_mixed.safetensors` (5.6 GB)
   - `vae/ae.safetensors` (0.3 GB)
3. Restart the host. **z-image-turbo:comfyui** appears in Settings → Image on every device connected with your code, and on this PC itself. It stays end-to-end encrypted.

**OmniGen2 (edits pictures).** OmniGen2 can change an existing picture instead of starting over: attach a photo and say what to change, or follow up on a picture with something like "make it night". Albatross sends those to OmniGen2 with the picture; new pictures still use the image model chosen in Settings → Image.

1. Install the [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) add-on into `ComfyUI\custom_nodes` and its requirements (`python_embeded\python.exe -s -m pip install -r ComfyUI\custom_nodes\ComfyUI-GGUF\requirements.txt`).
2. Put `omnigen2-fp32-q8_0.gguf` (6.7 GB) into `ComfyUI\models\unet`, and `qwen_2.5_vl_fp16.safetensors` (7.5 GB, from [Comfy-Org/Omnigen2_ComfyUI_repackaged](https://huggingface.co/Comfy-Org/Omnigen2_ComfyUI_repackaged)) into `ComfyUI\models\text_encoders`. It uses the same `vae/ae.safetensors` as Z-Image.
3. That GGUF file is tagged with the architecture "pig", which ComfyUI-GGUF doesn't recognise as OmniGen2 yet. On this PC `custom_nodes\ComfyUI-GGUF\tools\convert.py` has a small added `ModelOmniGen2` entry (and `loader.py` lists "omnigen2"). Updating the add-on removes that change, so add it again after an update.
4. Restart the host. **omnigen2:comfyui** appears next to Z-Image.

Only one model is kept in GPU memory at a time: before a chat or image, the host unloads every other Ollama model. The host starts ComfyUI (only reachable from this PC) on the first image request. The first image after that takes a while to load; after that a 1024×1024 image takes about 15 seconds on an RTX 5070. ComfyUI's log is in `host/comfyui.log`.

**Keep loaded (Settings → Image).** The image model stays loaded for a time frame after the last picture (10 minutes by default; 2 minutes to 12 hours). Pictures inside it start drawing right away, with no restart in between. A chat model in between only moves the image model off the graphics card; it stays in ComfyUI's memory and is back on the card in seconds. Once nothing was drawn for longer than the time frame, the host shuts ComfyUI down completely (graphics memory and RAM are free again), and the next picture loads it fresh. Switching to another picture model, running out of memory, or a hang also restart it. **Free GPU memory** unloads ComfyUI's models right away.

## Monitor: pictures and videos on the PC's screen

**Monitor** in the sidebar shows a picture or a video full screen on the PC's own screen, from any device with the code:

- **What:** a picture or video on the PC (Albatross pictures, received files, your Pictures, Videos and Downloads folders), the **newest generated picture** (it follows new ones, also from a List), a **YouTube** link (videos, Shorts, live; `&t=90` starts there), a picture or video address on the web, or a file **from this device** (saved in `Downloads\Albatross\Monitor`).
- **Layout:** fit, fill, stretch or original size; black, blurred, gray or white background; turn 0/90/180/270°; mirror; zoom.
- **Options:** sound and volume, loop, speed, a clock in a corner, a caption, and an info corner (name, size, display, time).
- **Videos:** play/pause, back/forward 10 s, from the start, and a position bar that follows the video.
- **Monitor data:** the PC's displays with resolution, refresh rate, colour depth, scaling, position, monitor and graphics card. Tap a display to show it there.

The window is Chrome or Edge in kiosk mode (no bars, own profile in `%LOCALAPPDATA%\Albatross\monitor-window`), started on the signed-in desktop by the desktop helper, so someone has to be signed in. **Close window** in the website closes it; on the PC, Alt+F4 does too. Videos play with sound by themselves. MP4 and WebM files work best; some YouTube videos don't allow being shown outside YouTube, and the Monitor then says so.

## Remote desktop: the PC's screen and mouse from any device

**Remote desktop** (Home → Your PC, or the Tools menu) shows the PC's screen live on your phone, tablet or another computer, and lets you use its mouse and keyboard. It goes end-to-end encrypted through your code, like everything else, and only the PC's owner can use it (never guests).

- **Mouse:** click, double-click, right-click, drag and scroll. **Touch:** tap to click, long press or two-finger tap to right-click, drag with one finger, scroll with two.
- **Keyboard:** click on the screen, then type: every key goes down and up on the PC, so shortcuts and held keys work. On a phone the keyboard button opens the on-screen keyboard. A row of buttons has Esc, Tab, Win, Alt+Tab, Ctrl+C/V/Z/A, Win+D, Alt+F4, Task Manager and the arrows.
- **Quality:** Auto, Sharp, Normal or Fast (a smaller, quicker picture for slow connections). With several displays, pick which one. Full screen hides everything else.
- The picture is taken about 8 times a second by the desktop helper on the signed-in desktop (`host/remotedesk.ps1`, so someone has to be signed in); a still screen sends nothing. The PC's control center notes when someone starts and stops viewing.

## Side panel: explain anything on the screen, or let the AI control the PC

The Windows app has a **side panel** that sits at the edge of the screen next to your other apps (Home → **Side panel**, the tray menu, or **Ctrl+Alt+Space**). It takes its strip of the screen like the taskbar does, so maximized windows end where it starts (Settings ⚙ in the panel: left or right side, or let it float over the other windows instead).

- **Explain:** press **Box** and drag a rectangle, or **Circle** and draw around something freehand. The AI explains what you picked (a chart, an error, a word, a button), or answers the question you typed first. Ask follow-up questions in the same box. The screen freezes while you pick (Esc cancels); the AI gets the part you picked, plus the whole screen small with that place marked, so it knows which app it's in. Needs a model that can see pictures (qwen3-vl, gemma3, gemma4).
- **Control my PC:** say what should happen ("open Notepad and write a shopping list"). The AI looks at the window in front (its picture and a numbered list of what can be clicked, from Windows' UI Automation), then clicks, types, presses keys, scrolls or opens programs, one step at a time, and looks again after each step, until it's done (at most 40 steps). Every step shows in the panel, with a short glow on the screen where it clicks. Needs a model that can use tools; one that can also see (qwen3-vl, gemma4) works much better.
  - **To stop it, just move your mouse**: as soon as the cursor goes anywhere the AI didn't put it, it stops at once (Stop and **Ctrl+Alt+X** work too). While the panel waits for your Allow or answer, moving the mouse doesn't count.
  - It can do everything a person at the PC can: click, double- and right-click, **hover**, **drag**, type, press and **hold** keys, scroll, open programs and web pages, **list and switch windows**, read and fill the **clipboard**, and look at the **whole screen** (taskbar, every window, notifications) instead of only the window in front. It can also **run PowerShell commands** and gets their output back; every command is shown to you and always waits for your **Allow**.
  - Steps that send, post, buy, pay or delete wait for your **Allow**. Tick **Ask before every step** to approve each click and key.
  - It never clicks on the panel itself, never types passwords (it asks you instead), and the panel never takes the keyboard while it works, so what it types goes to the app it works in.
- Everything stays on this PC: the pictures go to the AI on your own PC through the host, nothing to any server.

## List: several requests in a row

**List** (a tab of the side panel on the right, next to Browser, Agent and Code; the List button in the sidebar opens it) takes several requests at once and runs them **on the PC**, one after the other, for example a picture 3 times, then a text model writing about them. It keeps going when the website is closed or the phone sleeps. The results go into **the chat that is open** (they appear there as they come), or into a new chat if you pick *Into: a new chat*. While a list writes into a chat, that chat waits for it before you can write in it yourself. A chat kept only on this device gets a new chat on the PC instead.

- Each step is a **Picture** or **Text** step, with how many times (up to 20) and optionally its own model (otherwise the picture model from Settings → Image and the current chat model).
- Typing `image 3x: a red fox` or `text: write a story about it` sets the kind and the count by itself; pasting several such lines makes several steps.
- `{previous}` in a prompt is the last text answer, so a text step can write the prompt for a picture step.
- Text steps see the conversation so far (including what was in the chat before); a text model that can look at pictures also gets the pictures of the step before.
- Picture steps use your size, steps and style from Settings → Image; with a fixed seed every repeat gets the next seed, so they differ.
- The list shows progress, **Stop**, **Open chat** and **Edit again**. Only one list runs at a time; more wait their turn.

## Chrome extension: your own tools

The Albatross extension (`extension/`, load it unpacked in chrome://extensions) puts the chat in Chrome's sidebar. **⋯ → My tools** lets you make tools for the AI:

- **Run JavaScript on the page**: the code is the body of an async function. The inputs the AI fills in are in `args`, and you `return` the answer (text or JSON). It runs on the page you're on (turn on *Follow my tab*) and stops after 30 seconds.
- **Give the AI a text to follow**: a prompt with `{{input}}` gaps; the filled-in text goes back to the AI.

Give a tool a name, say what it does (the AI reads that to decide when to use it) and list its inputs. **Test** runs it before you save. The AI sees each tool as `my_name`, uses it when your question fits, and each use shows as a small card in the chat. Start from an example, or **Export** your tools to a file and **Import** them elsewhere (you see the code before anything is added).

- Tools are stored in the extension (`chrome.storage.local`). The chat only gets the name, description and inputs, never the code; the extension looks the code up itself when the AI asks for a tool.
- A page tool can read and change the page, like a bookmarklet. Only add tools you wrote or trust.
- The Minecraft redstone tool was taken out of the app on 2026-11-16 and is kept in `archive/redstone/` (see its README to put it back).

## Your own tools on the PC (and open-source tools)

Tools that live on your PC show up in the chat on any device connected to it (the website, the app, the Chrome sidebar), for you only: guests never get them. The AI sees them as `pc_name`, and every use shows as a small card in the chat.

- **Make one on the website:** Settings → Tools → **Your tools…**. A tool is a **text** for the AI to follow, or a **call to a web address** (a weather service, your own API, a webhook), with inputs the AI fills in. Test it before you save. Tools made here can only call public https addresses (never this PC or your home network) and can never run a program.
- **Programs go in a folder on the PC:** `host/my-tools/` (made on the first run; see `host/tools-examples/`). A `.json` file plus a `.js` file is a **script tool**; `mcp.json` connects **MCP servers**. Because only you can put files there, the website can't start a program on your PC. Changes are picked up by themselves.
- **Open-source tools:** MCP (Model Context Protocol) is the open standard most tool collections use: files, memory, git, databases, search and thousands more. Browse the [official MCP Registry](https://registry.modelcontextprotocol.io), the [reference servers](https://github.com/modelcontextprotocol/servers), [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) or [mcpservers.org](https://mcpservers.org), and add one to `mcp.json`. An MCP server is a program that runs on your PC with your rights: read what it does first, and give file servers only the folders they need.

## Accounts: your chats and lists stay yours

Chats live on the PC. While you're signed in (Settings → Account), your chats and lists are kept **per account**: in `%LOCALAPPDATA%\Albatross\Chats\accounts\<account>` on the PC, and under that account on each device. Signing in with the same account on another device shows the same chats; other accounts, and devices that aren't signed in, don't see them. Devices that aren't signed in share the chats directly in `Chats\`, as before.

- The website sends the account's sign-in token with chat and list requests, inside the end-to-end encryption. The PC checks it against Google's keys (signature, project, expiry) before it uses the account's folder; a token that doesn't check out is refused.
- The first time you sign in on a device that has chats from before, Albatross offers to **move the shared chats into your account**. The button is also in Settings → Account. They are only removed from the shared space once they are safely in your account.
- Signing out shows the shared chats again; your account's chats stay with your account.

**Files are kept per account too.** Pictures the AI draws, the AI's own folder, code projects, sharper pictures and files you send with Beam go into the asker's own folder in `Downloads\Albatross`:

| Who | Where |
| --- | --- |
| A signed-in account (owner or guest code) | `Accounts\<account>\` (Pictures, AI, Code, received files) |
| Guests without an account | `Guests\` |
| The owner without an account | `Downloads\Albatross\` itself, as before |

The PC files window and the AI only see the folder of whoever is asking. The owner's view leaves out the `Accounts` and `Guests` folders and can't reach into them. Guest chat summaries still include the guests' pictures. Files from before this change stay in the shared folder.

**Guest chat summaries look at the pictures.** When a guest chat made pictures, its summary is written by a model that can see them (the owner's chosen model if it can, otherwise a loaded one, otherwise any installed one), so it says what is really in them. The summary notes "looked at N pictures" when it did.

**QR codes.** Settings → Connection, the PC page and the control center have a **QR code** button next to each link. Scan it with a phone's camera to open the link and connect. The admin QR code gives full access, so only scan it on your own phone.
