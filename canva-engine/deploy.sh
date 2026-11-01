#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=70b94de589bd6a70c5d10533be6fb6ab42114e6851a3f8dc0a2e72c9d8c47931
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/fe512bb5da9b4c92e6cdfe63ec4bc7a8d6c78fbc/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
