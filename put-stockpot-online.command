#!/bin/zsh
# Double-click to put Stockpot online on Vercel and Supabase. Keys stay in .env.hosting on this Mac and in your Vercel project.
cd "${0:A:h}" || exit 1

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1

[ -d node_modules/pg ] || npm ci --legacy-peer-deps || exit 1
touch .env.hosting
chmod 600 .env.hosting

have() { grep -q "^$1=." .env.hosting; }
save() {
  local name="$1" value="$2"
  [ -z "$value" ] && return
  grep -v "^$name=" .env.hosting > .env.hosting.tmp
  print -r -- "$name=$value" >> .env.hosting.tmp
  mv .env.hosting.tmp .env.hosting
  chmod 600 .env.hosting
}

# Passcodes already chosen on this Mac are used on the real site too.
for name in OWNER_PASSCODE STAFF_PASSCODE; do
  have "$name" || save "$name" "$(grep "^$name=" .env 2>/dev/null | head -1 | cut -d= -f2-)"
done

echo "Put Stockpot online."
echo "What you paste here stays hidden and is saved only in .env.hosting on this Mac."
echo

if ! have DATABASE_URL; then
  echo "1. In your Supabase project, press Connect at the top, open Transaction pooler and copy the address."
  echo "   It has port 6543."
  read -rs "address?Paste the address: "; echo
  if [[ "$address" == *"[YOUR-PASSWORD]"* ]]; then
    read -rs "password?Your database password: "; echo
    encoded=$(PASSWORD_TEXT="$password" node -p 'encodeURIComponent(process.env.PASSWORD_TEXT)')
    address=${address//\[YOUR-PASSWORD\]/$encoded}
  fi
  save DATABASE_URL "$address"
  echo
fi

if ! have SUPABASE_SERVICE_KEY; then
  echo "2. In Supabase, open Project Settings, then API Keys."
  echo "   Copy the secret key that starts with sb_secret_. An older project shows a service_role key instead."
  while true; do
    read -rs "key?Paste the key: "; echo
    [[ -n "$key" && "$key" != sb_publishable_* ]] && break
    echo "That isn't the secret key. Copy the one under Secret keys, which starts with sb_secret_, then paste it here."
  done
  save SUPABASE_SERVICE_KEY "$key"
  echo
fi

if ! have OWNER_PASSCODE; then
  echo "3. Choose the passcodes people will use to sign in to the real site."
  read -rs "owner?Owner passcode: "; echo
  save OWNER_PASSCODE "$owner"
fi
if ! have STAFF_PASSCODE; then
  read -rs "staff?Staff passcode: "; echo
  save STAFF_PASSCODE "$staff"
  echo
fi

npx tsx scripts/go-online.ts 2>&1 | tee hosting.log
echo
read -s -k1 "?Press any key to close."
