#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=dbf9e3e948cef7fe6ef7f3f68281ac4e4ed446a69369bece38229b19dba89d42
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/1a72afd0a0fe5b4a9995083c39ea840ed9fec954/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
