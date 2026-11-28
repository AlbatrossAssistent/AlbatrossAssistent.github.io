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
- **Host on this device** (Settings → Connection): on the PC that runs Albatross, this switch connects the app to Albatross on that same PC and puts it online, so your other devices reach it with its code. It's remembered: every start connects and goes online again. Switching it off takes the PC offline; connecting somewhere else with a code switches it off.

### Updates of the Windows app

Releases are made by GitHub Actions (`.github/workflows/desktop.yml`): when `desktop/package.json` gets a new version on `main`, the smoke test runs on Linux, then a Windows machine builds the installer and publishes it as a GitHub release. The installed apps find it by themselves and update: right away when Albatross is only in the tray, otherwise from the **Update now** pop-up (the app closes, installs and opens again), **Restart to update** in the tray, or when you close the window. Inside the app, the website's "newer version" pop-up doesn't appear: the app's pages come with the app, so only a new app version updates them. To release, bump the version and push. A version that is already released is skipped; **Run workflow** on the Actions page starts it by hand.

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

**Live video (like Chrome Remote Desktop):** with the Windows app open on the PC (also just in the tray), the screen comes as WebRTC video straight to your device: only what changes travels, 60 frames per second at up to 1920x1080 inside your own network (30 when it goes over the internet), and 120 when both screens can show it (the PC's monitor and your device's screen at 100 Hz or more, quality Auto or Fast; a new picture every 8 ms instead of 16, while something moves). If your device can't keep up with 120 (it drops or skips frames), it goes back to 60 by itself and stays at 60 on that device for 14 days; and mouse and keyboard go back over the same direct connection. Mouse moves go out the moment you make them. On a phone or tablet your fingers become real touch input on the PC (tap, drag to scroll, pinch, press and hold to right-click), as Chrome Remote Desktop does it, and Windows hides the mouse pointer while you touch, so it isn't in the picture. Only the setup goes through the Albatross server (`/pc/rtc`, end-to-end encrypted; `desktop/rtc.js` captures the screen in a hidden window). When the two can't reach each other directly (some mobile networks) or the app isn't open, it falls back to the pictures by itself. The bar shows "Live · N fps · N ms delay" when it's on: the delay is how old the picture is when you see it, from the PC's screen to yours (hover for its parts: encoding on the PC, the network, decoding and showing on your device). The PC tells your device to show each frame the moment it's decoded, with no smoothing buffer (WebRTC playout delay 0, as game streaming does).

**Remote desktop** (Home → Your PC, or the Tools menu) shows the PC's screen live on your phone, tablet or another computer, and lets you use its mouse and keyboard. It goes end-to-end encrypted through your code, like everything else, and only the PC's owner can use it (never guests).

- **Mouse:** click, double-click, right-click, drag and scroll. **Touch:** tap to click, long press or two-finger tap to right-click, drag with one finger, scroll with two.
- **Keyboard:** click on the screen, then type: every key goes down and up on the PC, so shortcuts and held keys work. On a phone the keyboard button opens the on-screen keyboard. A row of buttons has Esc, Tab, Win, Alt+Tab, Ctrl+C/V/Z/A, Win+D, Alt+F4, Task Manager and the arrows.
- **Hide the PC's monitor** (the crossed-out screen in the bar, with live video): the PC's monitors show a plain white-on-black cover screen ("This PC is in use remotely") while you still see and use the desktop. Windows leaves the cover out of the screen capture, and clicks and keys go through it. It's a screen saver: the face, the words, the time and the key to close it drift slowly across the black screen, so nothing burns into it. It stays on for next time, and goes 5 seconds after you leave remote desktop or with Ctrl+Alt+Shift+U on the PC. Windows' own Start menu and notifications can still show above it.
- **One pointer:** as soon as you use a mouse or trackpad (an iPad's, a laptop's), the PC hides its own pointer, on its monitor and in the video, so you only see your device's own pointer, which moves without delay. It's hidden behind the cover too. It comes back 5 seconds after you leave, 10 seconds after your device goes quiet (asleep, out of Wi-Fi), with Ctrl+Alt+Shift+U at the PC (that works whenever the pointer is hidden), or when the helper (`host/remotedesk.ps1`) ends in any way; signing out brings it back as well.
- **HDR off:** an HDR desktop looks washed out and blooming in the video, so HDR is switched off on the PC's monitors when a live session starts (the screens go dark for a moment) and back on 5 seconds after it ends (also if the app was closed during it, the next time the helper starts).
- **Quality:** Auto, Sharp, Normal or Fast (a smaller, quicker picture for slow connections). With several displays, pick which one. Full screen hides everything else.
- The picture is taken about 8 times a second by the desktop helper on the signed-in desktop (`host/remotedesk.ps1`, so someone has to be signed in); a still screen sends nothing. The PC's control center notes when someone starts and stops viewing.

## Shortcuts: things your PC does by itself

**Shortcuts** (Home → This PC → Shortcuts, or the Tools menu) are a few steps your PC runs by itself. They run in the host on the PC (it runs from boot), so no browser has to be open. Kept in `host/shortcuts.json` (or the app's data folder).

- **Steps:** open a program or a website, a media key, set the volume or the brightness, lock, sleep, shut down (in a minute, cancel with `shutdown /a`), **say something out loud** (Windows' own voice; a German text gets a German voice if Windows has one), **call a link** (`https://…` is opened; `POST https://… {json}` sends that; also links in your home network, like a smart plug's), tell Jarvis, wait (`10s`, `5m`, `1h`). Steps that act on the desktop need someone signed in on the PC.
- **When:**
  - **a time** on chosen weekdays, also on holidays, **not on holidays**, or **only on holidays**. Up to 3 minutes late still counts (a busy or just-woken PC); a PC that's asleep or off at that time skips it.
  - **a date**, once or every year.
  - **sunrise or sunset** at one of your places, up to 2 hours before or after (worked out on the PC).
  - **every 5 minutes to 24 hours**, if wanted only between two times.
  - **when the PC starts** (a minute after Albatross is up).
  - **arriving at or leaving a place** (see below).
  - **Alexa**: every shortcut with "Alexa can start it" (see below).
  - **its own link** (Copy link in the editor), and **Run now**.
- **Only if:** rules that hold a shortcut back when it's started by a time, a place or the PC starting: **only between two times** (also across midnight), **only if someone is (or nobody is) at a place** (from the devices that reported where they are within the last 12 hours). By hand, from Alexa or from a link it always runs.
- **More steps:** **show a notification on the PC** (Windows' own, in the corner) and **run another shortcut** (at most 3 inside each other).
- **Holidays:** Germany's are worked out on the PC for every state (pick yours: Fronleichnam, Allerheiligen and others are only in some states). Other countries come from [Nager.Date](https://date.nager.at), a free public-holiday service: the PC asks once per country and year (only the country and the year are sent) and keeps the answer in `holidays-<country>-<year>.json`. **Your own days off** (a vacation, a bridge day) count as holidays too.
- **Places:** a circle around a spot, shown on a map (OpenStreetMap, loaded when you open Places): drag a pin to move a place, click the map or find an address (OpenStreetMap's search; only what you type is sent) to set a red pin and add a place there, or add where you are now; pick each circle's size. Two ways for the PC to know you arrived or left:
  - **Report where this device is** (a switch per device): while Albatross is open on it, the device tells the PC where it is (after moving 30 m, at most every 20 seconds, otherwise every 5 minutes). Browsers don't share the location of a closed page.
  - **In the background**, a phone automation opens the place's **Arrive** or **Leave** link. iPhone: Shortcuts app → Automation → Arrive/Leave → "Get Contents of URL" with the link. Android: an automation app (MacroDroid, Tasker) with a location trigger and an HTTP request.
  - Inside the circle counts as there, outside by more than the location's accuracy (at least 50 m) as gone, so standing at the edge doesn't flip back and forth. A device's first report only learns where it is. Two devices arriving together run it once (within 5 minutes).
- **Alexa:** your own Alexa skill, only for your Amazon account (free, not published). The Shortcuts page walks you through it: create a Custom skill with "Provision your own", paste the interaction model (English or German), paste the endpoint, build, and switch testing to Development. Then "Alexa, ask Albatross Home to start Good morning" (German: „Alexa, sag Albatros Zuhause, starte Guten Morgen“) runs the shortcut whose name matches best. Alexa routines can say that sentence too (action Customised). The first skill that calls the endpoint is linked to the PC; others are refused after that (Unlink the skill to set up a new one), and requests older than 150 seconds are refused. The other way round (Alexa says something or runs an Alexa routine): a Call a link step with a [Voice Monkey](https://voicemonkey.io) link.
- **Links and the server:** the links and Alexa reach the PC through the Albatross server (`/hook/<the PC's code>/<key>/…` in `server.js`), not end-to-end encrypted: Alexa and phone automations can't encrypt like the website. A link carries only a secret key and which shortcut or place, never what it does. The PC checks the key; wrong keys count as wrong codes (30 in 10 minutes block that address), and each address may open 30 links a minute. The server waits up to 7 seconds for the PC (Alexa allows 8) and tells Alexa when the PC is offline. **Make new links** replaces the key; all old links stop working, the Alexa endpoint too.

## AI games: what an AI can see

**AI games** on Home (`public/aigames.js`) runs an object detector in the browser (COCO-SSD with TensorFlow.js, loaded from jsDelivr the first time; "Fast AI" or "Precise AI"). Pictures never leave the device, and nothing here moves the real mouse.

- **Detect:** finds people and about 80 kinds of things (cars, dogs, cups, phones…) in the camera, a shared screen or window, a picture or a video, and draws a labelled box around each. Only people or everything, and how sure it has to be.
- **Target range:** a little shooting-range game made for the detector. Cardboard people walk across three lanes and pop up behind crates. The AI sees only the game's picture (no crosshairs or boxes in it) and aims the game's own crosshair at the people it finds: at human speed, fast, or as fast as it can. Or you play by clicking, or a Duel of you against the AI. After a round: hits, shots, accuracy and how long it took from seeing someone to hitting them. In a test round the fast AI hit 14 of 14 shots, about 1.5 seconds per person, looking 43 times a second.

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
- **The icon** opens a small menu (`popup.html`): the YouTube ad setting and **Open chat**, so the chat only shows when you want it. *The icon opens the chat directly* there goes back to opening the sidebar on click.
- **Detect** (the icon's menu, "Find people on this tab"): the AI finds the people on the page you're on (also in a browser game) and draws a box around each, with a small bar to switch to everything it knows or stop. The tab's picture goes to a hidden extension page (`detect-offscreen.html`, `chrome.tabCapture`) where the detector runs (TensorFlow.js and COCO-SSD, bundled in `extension/vendor`); `detect-overlay.js` draws the boxes. Frames come straight from the tab's video stream (MediaStreamTrackProcessor), and the bar shows each step and any error. It only looks: it never clicks, aims or types. It keeps looking in that tab, also on new pages and after reloads, until you press Stop or close the tab.
- **YouTube ads** (`extension/youtube.js`, `background.js`), three settings in the icon's menu or under **⋯ → YouTube ads** in the sidebar; a skipped ad shows a short "Ad skipped" note with the Albatross face in the player:
  - *skip* (default): an ad is muted, sped through at 16x and skipped as soon as YouTube allows; the video goes on with your own sound and speed. Banner ads over the video are closed.
  - *watch ahead, swap*: the ads are watched, just not by you. A second copy of the video runs in a hidden, muted tab (collapsed group "Ads ahead") about a minute ahead of you and plays the ads it meets there. When your copy reaches an ad that the hidden copy is already past, you're switched to the hidden copy at the same second, with your volume and speed; your old copy plays its ad muted and becomes the one ahead. The ad at the very start of a video stays (both copies get one). Switching tabs ends fullscreen.
  - *leave them*: nothing.
  - **Jump to the next ad** (same menu): the video you watch jumps to 10 seconds before its next ad (the places come from YouTube's own page, `youtube-main.js`), to try the settings with and without. A few seconds after the place it says whether an ad really came and what the setting did with it: an ad place is only an offer, and YouTube often leaves it empty (right after a jump, or soon after another ad). After an update, press the reload arrow on the extension in chrome://extensions once (Chrome asks to allow it on youtube.com).
- The Minecraft redstone tool was taken out of the app on 2026-11-16 and is kept in `archive/redstone/` (see its README to put it back).

## Your own tools on the PC (and open-source tools)

Tools that live on your PC show up in the chat on any device connected to it (the website, the app, the Chrome sidebar), for you only: guests never get them. The AI sees them as `pc_name`, and every use shows as a small card in the chat.

- **Make one on the website:** Settings → Tools → **Your tools…**. A tool is a **text** for the AI to follow, or a **call to a web address** (a weather service, your own API, a webhook), with inputs the AI fills in. Test it before you save. Tools made here can only call public https addresses (never this PC or your home network) and can never run a program.
- **Programs go in a folder on the PC:** `host/my-tools/` (made on the first run; see `host/tools-examples/`). A `.json` file plus a `.js` file is a **script tool**; `mcp.json` connects **MCP servers**. Because only you can put files there, the website can't start a program on your PC. Changes are picked up by themselves.
- **Open-source tools:** MCP (Model Context Protocol) is the open standard most tool collections use: files, memory, git, databases, search and thousands more. Browse the [official MCP Registry](https://registry.modelcontextprotocol.io), the [reference servers](https://github.com/modelcontextprotocol/servers), [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) or [mcpservers.org](https://mcpservers.org), and add one to `mcp.json`. An MCP server is a program that runs on your PC with your rights: read what it does first, and give file servers only the folders they need.

## Accounts: your chats and lists stay yours

**Signing in is needed.** When Albatross opens, it asks you to sign in (Google, or email and password) before anything else. A device that was signed in before opens straight away, and signing out brings the sign-in screen back. There's no opening animation anymore.

Chats live on the PC. While you're signed in (Settings → Account), your chats and lists are kept **per account**: in `%LOCALAPPDATA%\Albatross\Chats\accounts\<account>` on the PC, and under that account on each device. Signing in with the same account on another device shows the same chats; other accounts, and devices that aren't signed in, don't see them. Devices that aren't signed in share the chats directly in `Chats\`, as before.

- The website sends the account's sign-in token with chat and list requests, inside the end-to-end encryption. The PC checks it against Google's keys (signature, project, expiry) before it uses the account's folder; a token that doesn't check out is refused.
- The first time you sign in on a device that has chats from before, Albatross offers to **move the shared chats into your account**. The button is also in Settings → Account. They are only removed from the shared space once they are safely in your account.
- Signing out shows the shared chats again; your account's chats stay with your account.

**Files are kept per account too.** Pictures the AI draws, the AI's own folder, code projects, sharper pictures and files you send with Beam go into the asker's own folder in `Downloads\Albatross`:

| Who | Where |
| --- | --- |
| A signed-in account (admin code) | `Accounts\<account>\` (Pictures, AI, Code, received files) |
| A signed-in guest (guest code) | `Guests\<account>\` |
| Guests without an account | `Guests\` |
| The owner without an account | `Downloads\Albatross\` itself, as before |

The PC files window and the AI only see the folder of whoever is asking. The owner's view leaves out the `Accounts` and `Guests` folders and can't reach into them. Guest chat summaries still include the guests' pictures. Files from before this change stay in the shared folder.

**Guest chat summaries look at the pictures.** When a guest chat made pictures, its summary is written by a model that can see them (the owner's chosen model if it can, otherwise a loaded one, otherwise any installed one), so it says what is really in them. The summary notes "looked at N pictures" when it did.

**QR codes.** Settings → Connection, the PC page and the control center have a **QR code** button next to each link. Scan it with a phone's camera to open the link and connect. The admin QR code gives full access, so only scan it on your own phone.
