#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=812d7572581ff08f5990f87ba97d89bd270c0a9fd81d91b45cd9357c341b212b
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/b1b0aa2f31dbfd0cc1c6462e33fdfca201d10e0c/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
