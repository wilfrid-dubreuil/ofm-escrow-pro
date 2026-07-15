#!/usr/bin/env bash
set -u

export PATH=/home/wilfrid/.avm/bin:/home/wilfrid/.cargo/bin:/home/wilfrid/.local/share/solana/install/active_release/bin:$PATH
cd /mnt/c/ofm-escrow-pro/anchor-workspace || exit 1

pkill -f solana-test-validator 2>/dev/null || true
pkill -f agave-test-validator 2>/dev/null || true
pkill -f cargo 2>/dev/null || true
pkill -f "anchor test" 2>/dev/null || true
pkill -f "anchor build" 2>/dev/null || true
pkill -f ts-mocha 2>/dev/null || true
pkill -f mocha 2>/dev/null || true

fuser -k 8899/tcp 2>/dev/null || true
fuser -k 9900/tcp 2>/dev/null || true

rm -rf .anchor/test-ledger
rm -f final-serial-test.log final-serial-test.exit

anchor test > final-serial-test.log 2>&1
rc=$?
printf "%s\n" "$rc" > final-serial-test.exit
cat final-serial-test.log
printf "TEST_EXIT:%s\n" "$rc"
exit "$rc"

