Third-party code in this folder (all permissive licences, their licence files sit next to this one):
- spessasynth.js: spessasynth_lib 4.4.8 + spessasynth_core 4.4.10 (Apache-2.0, spessasus), with fflate 0.8.3 (MIT) and stb-vorbis (Apache-2.0)
  bundled into one file with esbuild (MIT). A SoundFont (.sf2/.sf3) synthesizer for the browser: used by the Music tool.
- spessasynth_processor.min.js: the AudioWorklet part of spessasynth_lib (same licence).
To rebuild: npm install spessasynth_lib esbuild; esbuild entry.js --bundle --format=esm --minify  (entry: export { WorkletSynthesizer, Sequencer } from "spessasynth_lib")
