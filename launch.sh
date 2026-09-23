#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/Library/Application Support/Desktop Pet/node/bin:$PATH"
cd "$ROOT"
git pull --ff-only || true
npm install
exec npm start
