#!/usr/bin/env bash
# Local run with fresh storage: tests/run_local.sh tests/input-local.json [file-to-put-in-kv-store-"uploads"]
# Serves samples/ on http://127.0.0.1:8766 during the run. PYTHON=path/to/python to choose the interpreter.
set -e
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
rm -rf storage && mkdir -p storage/key_value_stores/default
cp "$1" storage/key_value_stores/default/INPUT.json
if [ -n "$2" ]; then
  # upload the file to a named store "uploads", as a user would before the run
  CRAWLEE_STORAGE_DIR=./storage $PY -c "
import asyncio, sys, os
from apify import Actor
async def up():
    async with Actor:
        kvs = await Actor.open_key_value_store(name='uploads')
        await kvs.set_value(os.path.basename(sys.argv[1]), open(sys.argv[1], 'rb').read(), content_type='application/pdf')
asyncio.run(up())" "$2" >/dev/null 2>&1
  cp "$1" storage/key_value_stores/default/INPUT.json
fi
(cd samples && $PY -m http.server 8766 --bind 127.0.0.1 >/dev/null 2>&1) &
SERVER=$!
trap 'kill $SERVER' EXIT
sleep 1
NO_PROXY=127.0.0.1,localhost CRAWLEE_STORAGE_DIR=./storage $PY -m src
