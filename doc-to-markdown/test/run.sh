#!/usr/bin/env bash
# Usage: test/run.sh input.json  -> runs the Actor locally with fresh storage
set -e
cd "$(dirname "$0")/.."
rm -rf storage && mkdir -p storage/key_value_stores/default
cp "$1" storage/key_value_stores/default/INPUT.json
if [ -n "$2" ]; then mkdir -p storage/key_value_stores/uploads && cp "$2" storage/key_value_stores/uploads/; fi
NO_PROXY=127.0.0.1,localhost APIFY_LOCAL_STORAGE_DIR=./storage node src/main.js
