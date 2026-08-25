#!/usr/bin/env bash
# Fails the build if a server-only secret reaches a client chunk.
# Cheap insurance: turns a catastrophic leak into a red CI run.
set -euo pipefail

DIR="${1:-.next/static}"
[ -d "$DIR" ] || { echo "No build output at $DIR. Run 'npm run build' first."; exit 1; }

PATTERNS=(
  SUPABASE_SERVICE_ROLE_KEY
  MPESA_CONSUMER_SECRET
  MPESA_PASSKEY
  ETIMS_CMC_KEY
  cmcKey
)

FAILED=0
for p in "${PATTERNS[@]}"; do
  if grep -rl "$p" "$DIR" 2>/dev/null | head -1 | grep -q .; then
    echo "LEAK: '$p' found in client bundle"
    grep -rl "$p" "$DIR" | head -5
    FAILED=1
  fi
done

if [ "$FAILED" -eq 1 ]; then
  echo
  echo "A server-only secret is in the client bundle. Check for a NEXT_PUBLIC_"
  echo "prefix or an accidental import of serviceClient() from a 'use client' file."
  exit 1
fi

echo "No secrets in client bundle."
