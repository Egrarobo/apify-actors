#!/usr/bin/env python3
"""Rebuild our Actors from GitHub (version 1.0, tag latest), one at a time, so a new README reaches the Store.

  python3 tools/rebuild_actors.py google-hotels-prices google-trends-reliable                          # dry run
  python3 tools/rebuild_actors.py --env-file ~/CIRO3/.env --apply google-hotels-prices google-trends-reliable

Builds run one after another: four builds at once hit HTTP 402 (memory limit of the free plan, 8 Oct 2026).
A build costs a little platform credit (a few cents at most). Nothing else in the Actor is changed.
The token is read from APIFY_TOKEN or --env-file; it is never printed.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.apify.com/v2"


def load_token(env_file):
    token = os.environ.get("APIFY_TOKEN")
    if not token and env_file:
        with open(os.path.expanduser(env_file), encoding="utf-8") as f:
            for line in f:
                if line.strip().startswith("APIFY_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
    return token


def call(method, path, token, body=None, timeout=360):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.load(res)["data"]
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path}: HTTP {e.code} {e.read().decode(errors='replace')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file")
    ap.add_argument("--apply", action="store_true", help="start the builds (default: dry run)")
    ap.add_argument("names", nargs="+")
    args = ap.parse_args()
    if not args.apply:
        for name in args.names:
            print(f"would rebuild egra_van~{name} (version 1.0, tag latest)")
        print("Dry run: nothing started. Add --apply to build.")
        return
    token = load_token(args.env_file)
    if not token:
        sys.exit("No APIFY_TOKEN found.")
    failed = 0
    for name in args.names:
        b = call("POST", f"/acts/egra_van~{name}/builds?version=1.0&tag=latest&waitForFinish=300", token)
        status = b.get("status")
        if status in ("READY", "RUNNING"):
            b = call("GET", f"/actor-builds/{b['id']}?waitForFinish=300", token)
            status = b.get("status")
        print(f"{'*' if status == 'SUCCEEDED' else '-'} {name}: build {b.get('buildNumber')} {status}")
        failed += status != "SUCCEEDED"
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
