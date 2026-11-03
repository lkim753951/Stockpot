#!/bin/zsh
# Double-click to put the sample site on Vercel. It uses made-up data, no keys and no database.
cd "${0:A:h}" || exit 1

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1

vercel() { npx --yes vercel@65.10.0 "$@"; }

echo "Putting the Stockpot sample online. A browser opens if Vercel needs you to sign in."
echo
vercel whoami </dev/null >/dev/null 2>&1 || vercel login || { echo "Vercel sign-in didn't finish."; read -s -k1 "?Press any key to close."; exit 1 }

rm -rf .vercel
vercel link --yes --project stockpot-sample </dev/null 2>&1 | tail -2
echo
echo "Building on Vercel. This takes a minute or two."
vercel deploy --prod --yes </dev/null 2>&1 | tee hosting.log
rm -rf .vercel .env.local
echo
read -s -k1 "?Done. Press any key to close."
