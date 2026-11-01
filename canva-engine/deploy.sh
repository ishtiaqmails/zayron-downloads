#!/usr/bin/env bash
set -e
cd /opt/canva-engine
EXPECT=9f6f9e173bb6096f0eb89312e7cd1cceb627a88805eab4fa9672d146f0aa27a9
URL=https://raw.githubusercontent.com/ishtiaqmails/zayron-downloads/3e9c0902ec30467160a35d3591c4583ae162acde/canva-engine/server.js
curl -fsSL "$URL" -o server.new.js
echo "$EXPECT  server.new.js" | sha256sum -c
mv server.new.js server.js
pm2 restart canva-engine >/dev/null
sleep 9
IP=$(curl -s4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
TOK=$(node -e "require('/opt/galaxybot/src/db').query('select admin_token from canva_account where id=1').then(r=>{console.log(r.rows[0].admin_token);process.exit(0)}).catch(function(e){console.log('ERR');process.exit(1)})")
echo ""
echo "================= CANVA DASHBOARD ================="
echo "Open this in your browser:"
echo "http://$IP:4010/admin?token=$TOK"
echo "==================================================="
echo -n "engine status: "; curl -s localhost:4010/status; echo ""
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw status | grep -q "4010" || echo ">> Port closed by ufw. To open the dashboard run:  sudo ufw allow 4010/tcp"
fi
