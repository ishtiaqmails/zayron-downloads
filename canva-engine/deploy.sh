#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=053575372d62bda312251713a7835a16848be2ddecdc1ec38c57e04da613ade1
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/0fa8a4cbb981b1216f6d6b102a9a90a131b57004/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
