#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
THREADS="${HASHCATS_THREADS:-$(( $(nproc) * 3 ))}"
export HASHCATS_THREADS="$THREADS"
echo "[hashcats] run-max threads=$THREADS"
exec node mine.mjs --threads "$THREADS" "$@"
