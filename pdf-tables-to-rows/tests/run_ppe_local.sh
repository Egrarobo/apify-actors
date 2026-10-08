#!/usr/bin/env bash
# Local run that simulates pay-per-event pricing ($0.006 per page with data) and a spending limit.
# Usage: tests/run_ppe_local.sh tests/input-local.json 0.02   -> stops after 3 charged pages
set -e
cd "$(dirname "$0")/.."
export ACTOR_TEST_PAY_PER_EVENT=true
export APIFY_ACTOR_PRICING_INFO='{"pricingModel":"PAY_PER_EVENT","pricingPerEvent":{"actorChargeEvents":{"page-with-data":{"eventTitle":"PDF page with data","eventPriceUsd":0.006},"apify-default-dataset-item":{"eventTitle":"item","eventPriceUsd":0}}}}'
export APIFY_CHARGED_ACTOR_EVENT_COUNTS='{"page-with-data":0}'
export ACTOR_MAX_TOTAL_CHARGE_USD=${2:-1}
tests/run_local.sh "$1"
