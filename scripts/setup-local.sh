#!/usr/bin/env bash
# One-step setup for the private Rail Seat Finder web app (docs/app/SPEC.md).
#
#   scripts/setup-local.sh
#
# 1. checks Node.js 22+
# 2. runs npm install
# 3. creates .env from .env.example if missing, readable only by you (chmod 600)
# 4. asks for your Firecrawl API key (hidden input) if FIRECRAWL_API_KEY is empty
# 5. adds railyatri to ENABLE_UNOFFICIAL_SOURCES
# 6. starts the app (npm run app) on http://127.0.0.1:4321/
#
# The key is never printed, logged or passed on a command line: it is read with
# `read -s` and written to .env with shell built-ins only.
set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '%s\n' "$*"; }
fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

# --- 1. Node.js 22+ ---
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js 22 or later (e.g. brew install node)."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" =~ ^[0-9]+$ ]] || fail "Could not read the Node.js version."
((node_major >= 22)) || fail "Node.js 22 or later is needed; this is $(node --version)."
command -v npm >/dev/null 2>&1 || fail "npm is not installed."
say "Node.js $(node --version): OK"

# --- 2. dependencies ---
say "Installing dependencies (npm install)…"
npm install --no-fund --no-audit

# --- 3. .env ---
if [[ ! -f .env ]]; then
  [[ -f .env.example ]] || fail ".env.example is missing."
  (umask 077 && cp .env.example .env)
  say "Created .env from .env.example."
fi
chmod 600 .env

# Prints the last value of NAME= in .env (empty if unset), trimmed of surrounding whitespace.
env_value() {
  local name=$1 line value=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$name="* ]] && value=${line#"$name="}
  done <.env
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Sets NAME=VALUE in .env (replacing every NAME= line, or appending one), keeping the file private.
set_env() {
  local name=$1 value=$2 line tmp found=0
  tmp="$(mktemp .env.XXXXXX)"
  chmod 600 "$tmp"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$name="* ]]; then
      if ((found == 0)); then printf '%s=%s\n' "$name" "$value"; fi
      found=1
    else
      printf '%s\n' "$line"
    fi
  done <.env >"$tmp"
  if ((found == 0)); then printf '%s=%s\n' "$name" "$value" >>"$tmp"; fi
  mv -f "$tmp" .env
}

# --- 4. Firecrawl key ---
if [[ -z "$(env_value FIRECRAWL_API_KEY)" ]]; then
  [[ -t 0 ]] || fail "FIRECRAWL_API_KEY is empty in .env and there is no terminal to ask for it. Add it to .env, then run this again."
  say ""
  say "Live seats are read through Firecrawl with your own API key (https://firecrawl.dev)."
  key=""
  while [[ -z "$key" ]]; do
    if ! IFS= read -r -s -p "Paste your Firecrawl API key (input is hidden), then press Enter: " key; then
      printf '\n'
      fail "No key was entered. Run this again when you have your Firecrawl API key."
    fi
    printf '\n'
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    if [[ -z "$key" ]]; then
      say "Nothing was entered. Try again, or press Ctrl+C to stop."
    elif [[ "$key" =~ [[:space:]\"\'] ]]; then
      say "The key contains spaces or quotes, which is unexpected. Try again."
      key=""
    fi
  done
  set_env FIRECRAWL_API_KEY "$key"
  unset key
  say "Saved the key to .env."
else
  say "FIRECRAWL_API_KEY is already set in .env: OK"
fi

# --- 5. railyatri on ---
sources="$(env_value ENABLE_UNOFFICIAL_SOURCES)"
if [[ ",${sources// /}," == *",railyatri,"* ]]; then
  say "railyatri is already enabled: OK"
else
  if [[ -z "$sources" ]]; then sources="railyatri"; else sources="${sources},railyatri"; fi
  set_env ENABLE_UNOFFICIAL_SOURCES "$sources"
  say "Enabled railyatri in ENABLE_UNOFFICIAL_SOURCES."
fi

# --- 6. start ---
say ""
say "Starting Rail Seat Finder. Open http://127.0.0.1:4321/ (press Ctrl+C to stop)."
exec npm run app
