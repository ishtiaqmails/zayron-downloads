#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=b7502d0f44421b07f37d4fe7a90b9e9e29a2f085665d7235e19e323463972abd
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/d13cd6c76b1aa343b4260414a4e150c8557d3b3a/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
