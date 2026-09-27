#!/usr/bin/env bash
# Runs the Actor with a local named dataset "urls-ds" as the URL source.
set -e
cd "$(dirname "$0")/.."
rm -rf storage && mkdir -p storage/key_value_stores/default storage/datasets/urls-ds
cp test/input-dataset.json storage/key_value_stores/default/INPUT.json
echo '{"link":"http://127.0.0.1:8765/article.html","title":"a"}' > storage/datasets/urls-ds/000000001.json
echo '{"link":"http://127.0.0.1:8765/products.csv"}' > storage/datasets/urls-ds/000000002.json
echo '{"other":"no url here"}' > storage/datasets/urls-ds/000000003.json
NO_PROXY=127.0.0.1,localhost APIFY_LOCAL_STORAGE_DIR=./storage node src/main.js
