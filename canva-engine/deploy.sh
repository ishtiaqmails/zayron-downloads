#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=9865639aaa3f270bdd444bef0fa8ac3c9cfda4cc6ec16cffe71abd86feceed98
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/9f9d5e22ec6cdad541382cb644d7c564350e1b96/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
