Third-party code in this folder (all permissive licences, their licence files sit next to this one):
- spessasynth.js: spessasynth_lib 4.4.8 + spessasynth_core 4.4.10 (Apache-2.0, spessasus), with fflate 0.8.3 (MIT) and stb-vorbis (Apache-2.0)
  bundled into one file with esbuild (MIT). A SoundFont (.sf2/.sf3) synthesizer for the browser: used by the Music tool.
- spessasynth_processor.min.js: the AudioWorklet part of spessasynth_lib (same licence).
To rebuild: npm install spessasynth_lib esbuild; esbuild entry.js --bundle --format=esm --minify  (entry: export { WorkletSynthesizer, Sequencer } from "spessasynth_lib")
- fonts/InterTight-latin-700-900.woff2: Inter Tight (weights 700 to 900, Latin), SIL Open Font License 1.1 (fonts/LICENSE-InterTight.txt), from Google Fonts.
  The letters of the model wallpaper: the open font closest to Apple's SF Pro Display, for systems that don't have SF.
- pdfjs/pdf.min.mjs, pdfjs/pdf.worker.min.mjs: PDF.js (pdfjs-dist 5.4.296, Apache-2.0, pdfjs/LICENSE-pdfjs.txt), copied from node_modules.
  Reads the text of PDFs attached in the chat, in the browser; loaded only when a PDF is attached.
