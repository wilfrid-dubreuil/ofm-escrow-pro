#!/usr/bin/env bash
set -u
export PATH=/home/wilfrid/.avm/bin:/home/wilfrid/.cargo/bin:/home/wilfrid/.local/share/solana/install/active_release/bin:$PATH
cd /mnt/c/ofm-escrow-pro/anchor-workspace || exit 1
export ANCHOR_PROVIDER_URL=${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}
export ANCHOR_WALLET=/home/wilfrid/.config/solana/id.json
npx ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts" > full-test.log 2>&1
rc=$?
echo "$rc" > full-test.exit
cat full-test.log
echo "FULL_EXIT:$rc"
exit "$rc"

