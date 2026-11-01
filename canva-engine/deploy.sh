#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=cc8d13e3b6d54bb02ba1969ebc6b456dbfd469e423aa004124a2a1622bc5c629
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/870cece496b2c7710f747c28f603cc4cf6cb003d/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
