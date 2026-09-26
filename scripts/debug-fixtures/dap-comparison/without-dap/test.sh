#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
clang -std=c11 -O0 -g -Wall -Wextra -Werror -fno-omit-frame-pointer index_test.c index.c -o index_test
./index_test
clang -std=c11 -O0 -g -Wall -Wextra -Werror -fno-omit-frame-pointer ledger.c index.c -o ledger
./ledger
./ledger 1731
./ledger 99017
