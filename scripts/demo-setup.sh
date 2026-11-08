#!/usr/bin/env bash
# Prepare the demo: a funded buyer, the seller's bond, and on a local validator
# a USDC mint the buyer can actually spend.
#
# This is devnet bootstrap, not part of the protocol. It exists because the app
# is honest about chain state: a seller is only payable once its bond is posted,
# and a USDC escrow needs a real mint with a real balance.
#
# Run it after the app has served at least one request, because that is when the
# seller and arbiter keypairs are generated.
set -euo pipefail

cd "$(dirname "$0")/.."

# Key files are never rewritten by default. Rotating them orphans every escrow
# already opened against the old addresses, so it takes an explicit flag.
OVERRIDE_KEYS=0
for arg in "$@"; do
  case "$arg" in
    --override-keys) OVERRIDE_KEYS=1 ;;
    -h|--help)
      echo "usage: $0 [--override-keys]"
      echo "  --override-keys  regenerate local key files even if they exist"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

RPC="${AESDR_RPC:-http://127.0.0.1:8899}"
APP_DIR="$PWD/app"
KEYS_DIR="$APP_DIR/.keys"
ENV_FILE="$APP_DIR/.env.local"
KEYPAIR="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
MIN_BOND="${SELLER_MIN_BOND:-10000000}"

if [ "$OVERRIDE_KEYS" -eq 1 ]; then
  echo "rotating local keys in $KEYS_DIR"
  rm -f "$KEYS_DIR/buyer.json"
  rm -f "$APP_DIR/.local-usdc-mint"
fi

if [ ! -f "$KEYPAIR" ]; then
  echo "no payer keypair at $KEYPAIR" >&2
  exit 1
fi

solana -u "$RPC" block-height >/dev/null || {
  echo "no validator at $RPC - start one first" >&2
  exit 1
}

# Read the address the app persisted for a role.
role_address() {
  node -e "
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join('$KEYS_DIR', '$1.json');
    if (fs.existsSync(file)) {
      process.stdout.write(JSON.parse(fs.readFileSync(file, 'utf8')).address);
    }
  "
}

# Generate a buyer keypair once. An existing file is never overwritten: a
# replaced key would orphan every escrow opened against the old address.
if [ ! -f "$KEYS_DIR/buyer.json" ]; then
  echo "generating buyer key"
  mkdir -p "$KEYS_DIR"
  node -e "
    const { randomBytes } = require('node:crypto');
    const { writeFileSync } = require('node:fs');
    const { join } = require('node:path');
    const { getBase58Decoder, createKeyPairSignerFromPrivateKeyBytes } =
      require('@solana/kit');

    (async () => {
      const seed = randomBytes(32);
      const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
      writeFileSync(
        join('$KEYS_DIR', 'buyer.json'),
        JSON.stringify(
          {
            note: 'local development only, never commit',
            address: signer.address,
            secretKey: getBase58Decoder().decode(seed),
          },
          null,
          2
        )
      );
      console.log('  buyer:', signer.address);
    })();
  "
else
  echo "buyer key exists, keeping it ($(role_address buyer))"
fi

SELLER="$(role_address seller)"
ARBITER="$(role_address arbiter)"
BUYER="$(role_address buyer)"

if [ -z "$SELLER" ] || [ -z "$ARBITER" ]; then
  echo "start the app once so it generates app/.keys/{seller,arbiter}.json, then rerun" >&2
  exit 1
fi

echo "rpc:     $RPC"
echo "seller:  $SELLER"
echo "arbiter: $ARBITER"
echo "buyer:   $BUYER"

# Fund every role for rent and fees. Airdrops fail on mainnet by design, so a
# failure here is reported and left to the operator.
for who in "$SELLER" "$ARBITER" "$BUYER"; do
  echo "funding $who"
  solana -u "$RPC" transfer --allow-unfunded-recipient --keypair "$KEYPAIR" "$who" 2 >/dev/null 2>&1 ||
    solana -u "$RPC" airdrop 2 "$who" >/dev/null 2>&1 ||
    echo "  could not fund $who automatically"
done

echo "posting seller bond of $MIN_BOND lamports"
node -e "
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const {
    createKeyPairSignerFromPrivateKeyBytes,
    createSolanaRpc,
    getBase58Encoder,
  } = require('@solana/kit');
  const { Aesdr } = require('./pkgs/sdk');

  (async () => {
    const seed = getBase58Encoder().encode(
      JSON.parse(readFileSync(join('$KEYS_DIR', 'seller.json'), 'utf8')).secretKey
    );
    const seller = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const aesdr = new Aesdr({ rpc: createSolanaRpc('$RPC') });

    const bond = await aesdr.bondBalance(seller.address);
    const target = BigInt('$MIN_BOND');
    if (bond >= target) {
      console.log('  bond already sufficient:', bond.toString());
      return;
    }

    const signature = await aesdr.postBond({ seller, amount: target - bond });
    console.log('  bond posted:', signature);
  })().catch((err) => {
    console.error('  bond failed:', err.message);
    process.exit(1);
  });
"

# USDC only matters on a local validator, where Circle has no deployment. The
# mint is created here and written into .env.local so the app prices in it.
#
# Delegated to a Node script because `spl-token` 5.5 defaults to Token-2022,
# and the escrow program uses the legacy token program. See scripts/local-usdc.mts.
if [ -z "${USDC_MINT:-}" ] && grep -q "127.0.0.1\|localhost" <<<"$RPC"; then
  echo "setting up a local USDC mint (legacy token program)"

  if LOCAL_MINT="$(AESDR_RPC="$RPC" AESDR_APP_DIR="$APP_DIR" \
      node --experimental-strip-types scripts/local-usdc.mts)"; then
    USDC_MINT="$LOCAL_MINT"
    # The mint script writes USDC_MINT into .env.local itself, once the mint is
    # confirmed, so a later failure cannot leave a stale address behind.
    echo "  local USDC mint ready: $USDC_MINT"
  else
    echo "  USDC setup failed; the SOL path still works" >&2
  fi
fi

echo
echo "ready. restart the app so it picks up USDC_MINT, then run:"
echo "  npm run e2e              # USDC"
echo "  npm run e2e:sol          # native SOL"
