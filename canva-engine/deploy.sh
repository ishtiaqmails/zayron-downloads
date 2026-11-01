#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=884b7fa6b494983b84e371193072adc1269957f05273f3c292fbb1015f2d1df4
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/d213ac29dd9a8831304fc09d4c266ca4c997cee0/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
