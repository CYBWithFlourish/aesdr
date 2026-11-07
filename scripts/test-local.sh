#!/usr/bin/env bash
# Run the full test suite against a throwaway validator.
#
# `anchor test` is no longer used: Anchor's harness bootstraps web3.js v1 and an
# Anchor provider, and this project targets @solana/kit. Booting the validator
# ourselves also means the program is preloaded instead of deployed per run.
set -euo pipefail

cd "$(dirname "$0")/.."

PROGRAM_ID="$(node -e "console.log(require('./target/idl/aesdr.json').address)" 2>/dev/null || true)"
if [ -z "${PROGRAM_ID}" ]; then
  echo "no target/idl/aesdr.json - run 'anchor build' first" >&2
  exit 1
fi

if [ ! -f target/deploy/aesdr.so ]; then
  echo "no target/deploy/aesdr.so - run 'anchor build' first" >&2
  exit 1
fi

LEDGER="$(mktemp -d)"
LOG="$(mktemp)"

cleanup() {
  if [ -n "${VALIDATOR_PID:-}" ] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  rm -rf "$LEDGER" "$LOG"
}
trap cleanup EXIT

echo "starting validator (ledger: $LEDGER)"
solana-test-validator \
  --reset \
  --quiet \
  --ledger "$LEDGER" \
  --bpf-program "$PROGRAM_ID" target/deploy/aesdr.so >"$LOG" 2>&1 &
VALIDATOR_PID=$!

echo "waiting for RPC"
for _ in $(seq 1 60); do
  if solana -u http://127.0.0.1:8899 block-height >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! solana -u http://127.0.0.1:8899 block-height >/dev/null 2>&1; then
  echo "validator did not come up; log:" >&2
  tail -40 "$LOG" >&2
  exit 1
fi

echo "program: $PROGRAM_ID"

# Tests build the packages first, since they import the built output.
npm run build --workspaces --if-present

AESDR_RPC=http://127.0.0.1:8899 \
  npx ts-mocha -p ./tsconfig.json -t 600000 "tests/**/*.ts"
