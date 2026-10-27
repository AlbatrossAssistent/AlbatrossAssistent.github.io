// Installs the git pre-push hook: before anything is pushed, the smoke test (test/smoke.js) runs, and a broken app is not
// pushed (so it never reaches Render or GitHub Pages).   node test/install-hook.js
// To push anyway in an emergency: git push --no-verify
const fs = require("fs"), path = require("path");
const hook = path.join(__dirname, "..", ".git", "hooks", "pre-push");
fs.writeFileSync(hook, `#!/bin/sh
# Albatross: test the app before it is pushed (test/smoke.js). Installed by test/install-hook.js.
echo "Testing the app before pushing..."
if ! node test/smoke.js; then
  echo ""
  echo "Push stopped: the app has a problem (see above). Fix it and push again."
  exit 1
fi
`, { mode: 0o755 });
console.log("pre-push hook installed: " + hook);
