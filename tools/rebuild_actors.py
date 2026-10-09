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
import time
import urllib.error
import urllib.request

API = "https://api.apify.com/v2"


def load_token(env_file):
    """--env-file wins; APIFY_TOKEN from the environment is only the fallback (with a warning if both exist)."""
    env_token = os.environ.get("APIFY_TOKEN")
    if env_file:
        with open(os.path.expanduser(env_file), encoding="utf-8") as f:
            for line in f:
                if line.strip().startswith("APIFY_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if token:
                        if env_token and env_token != token:
                            print("Note: APIFY_TOKEN in the environment differs from --env-file; using --env-file.")
                        return token
        print("Note: no APIFY_TOKEN in --env-file; falling back to the environment.")
    return env_token


def call(method, path, token, body=None, timeout=90):
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
        # waitForFinish is capped at 60 s by the API, so keep asking until the build ends (at most ~10 minutes).
        b = call("POST", f"/acts/egra_van~{name}/builds?version=1.0&tag=latest&waitForFinish=60", token, timeout=90)
        status = b.get("status")
        deadline = time.time() + 600
        while status in ("READY", "RUNNING") and time.time() < deadline:
            b = call("GET", f"/actor-builds/{b['id']}?waitForFinish=60", token, timeout=90)
            status = b.get("status")
        if status in ("READY", "RUNNING"):
            print(f"- {name}: build {b.get('buildNumber')} still {status} after 10 minutes; check it in Console (it keeps going)")
            failed += 1
            continue
        print(f"{'*' if status == 'SUCCEEDED' else '-'} {name}: build {b.get('buildNumber')} {status}")
        failed += status != "SUCCEEDED"
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
