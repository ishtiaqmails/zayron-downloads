#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=249f7719fc17ddd2c12f9868ec7f086847207831cecf3a10948ca31e2c330b10
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/9f061aaa05e6b4f1e2fffa1362095fe487a9fd9b/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
