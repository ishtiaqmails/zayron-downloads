#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=60fe1df39a82d65bbc7435778d0154d650ed701b55d89a6800e87b5742727d6d
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/21641524fde115e746f9b048fbeebccef65c127a/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
