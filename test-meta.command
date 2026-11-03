#!/bin/zsh
# Double-click to test the real Meta models with the key in .env. It uses only the fictional sample files.
cd "${0:A:h}" || exit 1

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
command -v nvm >/dev/null 2>&1 && { nvm use >/dev/null 2>&1 || nvm install; }

if [ ! -d node_modules/@vercel/functions ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing what Stockpot needs. This takes a few minutes after an update."
  npm ci --legacy-peer-deps || { echo "Install failed."; read -s -k1 "?Press any key to close."; exit 1; }
fi

echo "Testing Meta. This takes a minute or two."
echo
npm run --silent check:meta 2>&1 | tee meta-report.log
echo
read -s -k1 "?Done. Press any key to close."
