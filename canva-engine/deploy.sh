#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=5b969c76212d547ca679f73d59d1ffc260cf72ae6a6f24230a79a1f377f9430f
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/2d880114235a50b1e6f708a6db278c438a41f2f6/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
