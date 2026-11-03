#!/bin/zsh
# Double-click after Stockpot is running. Gives WhatsApp a public address for replies.
# The address reaches only the signed webhook on port 8788, never your owner screens.
cd "${0:A:h}" || exit 1

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1

token=$(grep '^WHATSAPP_VERIFY_TOKEN=' .env 2>/dev/null | cut -d= -f2-)
if [ -z "$token" ]; then
  echo "Run connect-apis.command first."
  read -k 1
  exit 1
fi
port=$(grep '^WEBHOOK_PORT=' .env | cut -d= -f2-)
port=${port:-8788}

if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/whatsapp/webhook"; then
  echo "Stockpot isn't listening for WhatsApp yet. Double-click start-stockpot.command, then try this again."
  read -k 1
  exit 1
fi

if command -v cloudflared >/dev/null 2>&1; then tunnel=(cloudflared); else tunnel=(npx -y cloudflared); fi
log=$(mktemp)
echo "Opening the address. Keep this window open while you use WhatsApp replies."
"${tunnel[@]}" tunnel --no-autoupdate --url "http://127.0.0.1:$port" > "$log" 2>&1 &
child=$!
trap 'kill $child 2>/dev/null; rm -f "$log"' EXIT

url=""
for attempt in {1..60}; do
  url=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | grep -v '//api\.' | head -1)
  [ -n "$url" ] && break
  sleep 1
done
if [ -z "$url" ]; then
  echo "The address didn't open. What it said:"
  tail -5 "$log"
  read -k 1
  exit 1
fi

echo
echo "In your Meta app, open WhatsApp, Configuration, Webhook, and press Edit."
echo
echo "  Callback URL:  $url/whatsapp/webhook"
echo "  Verify token:  $token"
echo
echo "Press Verify and save, then subscribe to the messages field."
echo "This address changes each time you run this, so paste the new one when it does."
echo
wait $child
