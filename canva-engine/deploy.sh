#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=abea8548a090f4902d5a7679acdf2c30e21607aac601d3e624a0a2d860417b26
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/9f25f56bceee90c2f9a50ed37c5e298177fe346d/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
