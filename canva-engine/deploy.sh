#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=03969bf4c61a72613028ec9a040ef825ef3bcc8d22ad9bc49a7f451ea922d9ca
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/1df189aaa414b0f532e09be30f6442c436634231/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
