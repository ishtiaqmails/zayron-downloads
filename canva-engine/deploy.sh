#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=efa1838c875883f7af7c5bf9ca1366fc306bdf46a285d57240e1b1d742870e94
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/c780e256da7d46185fb233aa05f9fdb4a585a193/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
