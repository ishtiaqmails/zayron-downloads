#!/usr/bin/env bash
set -e
BASE=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/0fa8a4cbb981b1216f6d6b102a9a90a131b57004/canva-engine/dash
TMP=$(mktemp -d)
for f in canva-routes.js canva.ejs canva.js patch.js; do curl -fsSL "$BASE/$f" -o "$TMP/$f"; done
node "$TMP/patch.js" "$TMP"
PROC=$(pm2 jlist | node -e "let d=JSON.parse(require('fs').readFileSync(0,'utf8'));let p=d.find(x=>x.pm2_env&&x.pm2_env.pm_cwd&&x.pm2_env.pm_cwd.indexOf('galaxydash')>=0);process.stdout.write(p?p.name:'')" 2>/dev/null || true)
if [ -n "$PROC" ]; then pm2 restart "$PROC" >/dev/null && echo "restarted pm2: $PROC"; else echo ">> Could not auto-detect the dashboard pm2 process — run: pm2 restart <name>"; fi
echo "Open your dashboard and click: Canva Education (under Automation)"
