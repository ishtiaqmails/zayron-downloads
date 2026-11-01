#!/usr/bin/env bash
set -e
BASE=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/b1b0aa2f31dbfd0cc1c6462e33fdfca201d10e0c/canva-engine/bot
TMP=$(mktemp -d)
for f in canvaDelivery.js patch-bot.js; do curl -fsSL "$BASE/$f" -o "$TMP/$f"; done
node "$TMP/patch-bot.js" "$TMP"
PROC=$(pm2 jlist | node -e "let d=JSON.parse(require('fs').readFileSync(0,'utf8'));let p=d.find(x=>x.pm2_env&&x.pm2_env.pm_cwd&&x.pm2_env.pm_cwd.indexOf('galaxybot')>=0);process.stdout.write(p?p.name:'')" 2>/dev/null || true)
if [ -n "$PROC" ]; then pm2 restart "$PROC" >/dev/null && echo "restarted pm2: $PROC"; else echo ">> Could not auto-detect the bot process — run: pm2 restart galaxy-bot"; fi
echo "Canva automation is OFF by default — flip it on from the dashboard Delivery mode card when ready."
