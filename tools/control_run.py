#!/usr/bin/env python3
"""One control run of our own Actor: start it, wait, print the outcome and the platform cost we pay.

Usage:
  python3 tools/control_run.py au-grocery-prices --input '{"searchTerms":["milk"],"maxItemsPerSearch":50}' --env-file ~/CIRO3/.env
  python3 tools/control_run.py au-grocery-prices --input '{...}' --dry-run     # only show what would be sent

The token is read from APIFY_TOKEN in the environment or from APIFY_TOKEN=... in --env-file.
It is never printed and never passed on the command line. Nothing is changed in the Actor itself.
"""
import argparse
import json
import os
import sys
import time
import urllib.request

USERNAME = "egra_van"
API = "https://api.apify.com/v2"


def load_token(env_file):
    token = os.environ.get("APIFY_TOKEN")
    if not token and env_file:
        with open(os.path.expanduser(env_file), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("APIFY_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
    return token


def call(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.load(res)["data"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("actor", help="Actor name, e.g. au-grocery-prices")
    ap.add_argument("--input", required=True, help="run input as JSON")
    ap.add_argument("--env-file", help="file with APIFY_TOKEN=...")
    ap.add_argument("--timeout", type=int, default=600, help="max seconds to wait (default 600)")
    ap.add_argument("--dry-run", action="store_true", help="print what would be sent and stop")
    args = ap.parse_args()

    run_input = json.loads(args.input)
    print(f"Actor: {USERNAME}~{args.actor}")
    print("Input: " + json.dumps(run_input, ensure_ascii=False))
    if args.dry_run:
        print("Dry run: nothing started.")
        return
    token = load_token(args.env_file)
    if not token:
        sys.exit("No APIFY_TOKEN found (environment or --env-file).")

    run = call("POST", f"/acts/{USERNAME}~{args.actor}/runs?waitForFinish=60", token, run_input)
    print(f"Run {run['id']} started.")
    deadline = time.time() + args.timeout
    while run["status"] in ("READY", "RUNNING") and time.time() < deadline:
        run = call("GET", f"/actor-runs/{run['id']}?waitForFinish=60", token)
    print(f"Status: {run['status']}  {run.get('statusMessage') or ''}")
    if run["status"] in ("READY", "RUNNING"):
        print("Still running after the timeout; check it in Console.")
        return

    ds = call("GET", f"/datasets/{run['defaultDatasetId']}", token)
    items = ds.get("itemCount") or 0
    usage = run.get("usageTotalUsd")
    secs = (run.get("stats") or {}).get("runTimeSecs")
    mem = (run.get("options") or {}).get("memoryMbytes")
    print(f"Items in dataset: {items}")
    print(f"Charged events: {json.dumps(run.get('chargedEventCounts') or {})}")
    print(f"Run time: {secs} s at {mem} MB")
    print(f"Platform cost we pay (usageTotalUsd): {usage}")
    if usage is not None and items:
        print(f"Cost per 1,000 items: ${usage / items * 1000:.4f}")
    print(f"Console: https://console.apify.com/view/runs/{run['id']}")


if __name__ == "__main__":
    main()
