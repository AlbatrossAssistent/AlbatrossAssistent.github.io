# Redstone tool (archived)

The Minecraft redstone designer was taken out of the live app on 2026-11-16. It is kept here so it isn't lost.

- `redstone.js`: the logic synthesis, simulation and the 2D schematic / truth table card (`redstonePlan`, `redstoneVisual`)
- `redstone3d.js`: the 3D block view
- Git tag `archive/redstone` = the last commit that still had it fully wired in (`git checkout archive/redstone`).

## Putting it back
1. Move both `.js` files back to `public/` and add the two `<script>` tags (`redstone3d.js` then `redstone.js`) after `account.js` in `public/index.html`.
2. Re-add the `redstone_design` tool in `public/agent.js` and the `redstone` entry in `CHAT_TOOLS` in `public/app.js`
   (copy them from the tagged commit: `git show archive/redstone:public/app.js`).

Nothing in the app loads this folder.
