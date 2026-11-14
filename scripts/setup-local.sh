#!/usr/bin/env bash
# One-time setup and start for the private web app (Rail Seat Finder).
#
#   bash scripts/setup-local.sh        # first time: installs, asks for the key, starts
#   npm run app                        # every time after that
#
# The Firecrawl key is typed hidden, stored only in .env (git-ignored, chmod 600)
# and never printed.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install it with:  brew install node   (or from https://nodejs.org), then run this again."
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 22 ]; then
  echo "Node.js $major found; version 22 or newer is needed. Update with:  brew upgrade node"
  exit 1
fi

echo "Installing dependencies (one minute)..."
npm install --no-audit --no-fund --loglevel=error

[ -f .env ] || cp .env.example .env
chmod 600 .env

if ! grep -Eq '^FIRECRAWL_API_KEY=.+' .env; then
  printf "Paste your Firecrawl API key (it stays hidden) and press Enter: "
  IFS= read -r -s key
  echo
  if [ -z "$key" ]; then
    echo "No key entered. The app will start with live seats off; run this script again to add it."
  else
    FIRECRAWL_KEY="$key" node -e '
      const fs = require("fs");
      let s = fs.readFileSync(".env", "utf8");
      const set = (k, v) => {
        const re = new RegExp("^" + k + "=.*$", "m");
        s = re.test(s) ? s.replace(re, () => k + "=" + v) : s + "\n" + k + "=" + v + "\n";
      };
      set("FIRECRAWL_API_KEY", process.env.FIRECRAWL_KEY.trim());
      const cur = (s.match(/^ENABLE_UNOFFICIAL_SOURCES=(.*)$/m) || [, ""])[1].split(",").map((x) => x.trim()).filter(Boolean);
      if (!cur.includes("railyatri")) cur.push("railyatri");
      set("ENABLE_UNOFFICIAL_SOURCES", cur.join(","));
      fs.writeFileSync(".env", s, { mode: 0o600 });
    '
    unset key
    echo "Key saved to .env on this computer only."
  fi
fi

echo
echo "Starting Rail Seat Finder. Open http://127.0.0.1:4321 in your browser. Press Ctrl+C to stop."
exec npm run app
