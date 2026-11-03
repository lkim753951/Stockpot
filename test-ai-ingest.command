#!/bin/zsh
# Double-click to test file reading with the real Meta models, using the fictional datasets. It uses the key in .env.
# It runs in a throwaway database, so it can't touch your data, and it writes ingest-report.md beside this file.
cd "${0:A:h}" || exit 1

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
command -v nvm >/dev/null 2>&1 && { nvm use >/dev/null 2>&1 || nvm install; }

if ! command -v npm >/dev/null 2>&1; then
  echo "Stockpot needs Node.js. Install it from https://nodejs.org, then double-click this file again."
  read -s -k1 "?Press any key to close."
  exit 1
fi

if ! grep -q "^MODEL_API_KEY=." .env 2>/dev/null; then
  echo "Add your Meta key first. Double-click connect-apis.command, then try this again."
  read -s -k1 "?Press any key to close."
  exit 1
fi

if [ ! -d node_modules/mammoth ] || [ ! -d node_modules/read-excel-file ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "Installing what Stockpot needs. This takes a few minutes after an update."
  npm ci --legacy-peer-deps || { echo "Install failed."; read -s -k1 "?Press any key to close."; exit 1; }
fi

echo "Reading every sample file with the real Meta models. This takes a few minutes and uses a little of your credit."
echo
npx -y node@22 --no-warnings --import tsx scripts/test-ai-ingest.ts
echo
echo "Open ingest-report.md in this folder to see the results."
read -s -k1 "?Press any key to close."
