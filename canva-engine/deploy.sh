#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=1f5583083c23d1a0913484a22348131b39f035fd51cff9c4eae11e7df5c6bd30
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/185eb63ab515e7b6cfcb36890d89409c4d255a5c/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
