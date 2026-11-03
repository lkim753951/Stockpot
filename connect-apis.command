#!/bin/zsh
# Double-click to connect Stockpot to Meta and WhatsApp. Keys and numbers stay in the .env file on this Mac.
cd "${0:A:h}" || exit 1

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1

[ -f .env ] || cp .env.example .env
chmod 600 .env

save() {
  local name="$1" value="$2"
  [ -z "$value" ] && return
  grep -v "^$name=" .env > .env.tmp
  print -r -- "$name=$value" >> .env.tmp
  mv .env.tmp .env
  chmod 600 .env
}

echo "Connect Stockpot. Press Return to skip anything."
echo "What you paste here stays hidden and is saved only in .env on this Mac."
echo
echo "1. Meta AI key: create one at https://dev.meta.ai/platform"
read -rs "key?Paste your Meta API key: "; echo
save MODEL_API_KEY "$key"
echo
echo "2. WhatsApp: from WhatsApp, API Setup in your Meta app, at https://developers.facebook.com/apps"
read -rs "token?Paste your WhatsApp access token: "; echo
save WHATSAPP_TOKEN "$token"
read -r "phone?Paste your WhatsApp phone number ID: "
save WHATSAPP_PHONE_NUMBER_ID "$phone"
read -rs "owner?Your own WhatsApp number, with country code: "; echo
save WHATSAPP_OWNER_NUMBER "$owner"
echo
echo "3. Staff (optional). Leave empty and checklists come to your own phone, which is fine for a demo."
echo "   Write it as Name:number, with commas between people."
read -rs "staff?Staff names and numbers: "; echo
save WHATSAPP_STAFF_NUMBERS "$staff"
echo
echo "4. Replies: from App settings, Basic in your Meta app. Needed so a forged message can't get in."
read -rs "secret?Paste your app secret: "; echo
save WHATSAPP_APP_SECRET "$secret"
grep -q '^WHATSAPP_VERIFY_TOKEN=.' .env || save WHATSAPP_VERIFY_TOKEN "stockpot-$(openssl rand -hex 16)"
echo

echo "5. Phone calls (optional): from the Twilio Console, at https://console.twilio.com"
read -r "sid?Paste your Twilio account SID: "
save TWILIO_ACCOUNT_SID "$sid"
read -rs "auth?Paste your Twilio auth token: "; echo
save TWILIO_AUTH_TOKEN "$auth"
read -rs "from?Your Twilio phone number, starting with +: "; echo
save TWILIO_FROM_NUMBER "$from"
read -rs "ring?The phone that should ring for you: "; echo
save OWNER_PHONE "$ring"
echo

if [ -n "$key" ]; then
  echo "Testing your Meta key. This uses a few pence of credit."
  npx -y node@22 --import tsx scripts/check-meta.ts
fi

echo
echo "Done. Double-click start-stockpot.command to restart Stockpot."
echo "For replies from staff, then double-click open-whatsapp-replies.command."
echo "Press any key to close."
read -k 1
