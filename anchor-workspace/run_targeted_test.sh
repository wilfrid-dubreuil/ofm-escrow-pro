#!/usr/bin/env bash
set -u
export PATH=/home/wilfrid/.avm/bin:/home/wilfrid/.cargo/bin:/home/wilfrid/.local/share/solana/install/active_release/bin:$PATH
cd /mnt/c/ofm-escrow-pro/anchor-workspace || exit 1
export ANCHOR_PROVIDER_URL=${ANCHOR_PROVIDER_URL:-https://api.devnet.solana.com}
export ANCHOR_WALLET=/home/wilfrid/.config/solana/id.json
anchor build > targeted-build.log 2>&1
build_rc=$?
if [ "$build_rc" -ne 0 ]; then
  echo "$build_rc" > targeted-test.exit
  cat targeted-build.log
  exit "$build_rc"
fi
anchor deploy > targeted-deploy.log 2>&1
deploy_rc=$?
if [ "$deploy_rc" -ne 0 ]; then
  echo "$deploy_rc" > targeted-test.exit
  cat targeted-build.log
  cat targeted-deploy.log
  exit "$deploy_rc"
fi
npx ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts" --grep initialize_distribution > targeted-test.log 2>&1
rc=$?
echo "$rc" > targeted-test.exit
cat targeted-build.log
echo "-----"
cat targeted-deploy.log
echo "-----"
cat targeted-test.log
echo "TARGET_EXIT:$rc"
exit "$rc"

