#!/bin/zsh
# Double-click to run Stockpot on this Mac. Press Ctrl+C in this window to stop it.
cd "${0:A:h}" || exit 1

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1

if ! command -v npm >/dev/null 2>&1; then
  echo "Stockpot needs Node.js. Install it from https://nodejs.org, then double-click this file again."
  read -k 1
  exit 1
fi

running=$(lsof -nP -tiTCP:8787 -sTCP:LISTEN | head -1)
if [ -n "$running" ]; then
  if ps -o command= -p "$running" | grep -q 'server/index.ts'; then
    echo "Stopping the copy of Stockpot that is already running."
    kill "$running"
    sleep 2
  else
    echo "Something else is using port 8787. Close it, then double-click this file again."
    ps -o command= -p "$running"
    read -k 1
    exit 1
  fi
fi

echo "Installing and building Stockpot. This takes a few minutes after an update."
if [ ! -d node_modules/ogg-opus-decoder ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci --legacy-peer-deps || { echo "Install failed."; read -k 1; exit 1; }
fi
npm run build || { echo "Build failed."; read -k 1; exit 1; }

( until curl -sf http://localhost:8787/api/staff/runs >/dev/null; do sleep 1; done; open http://localhost:8787 ) &
npx -y node@22 --import tsx server/index.ts
