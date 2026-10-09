#!/usr/bin/env python3
"""Make the named Actors public in Apify Store.

  python3 tools/publish_actors.py --env-file ~/CIRO3/.env pdf-invoice-table-extractor google-ads-transparency

Prints each Actor's latest build status and sets isPublic = true only if that build SUCCEEDED.
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


def call(method, path, token, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.load(res)["data"]
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path}: HTTP {e.code} {e.read().decode(errors='replace')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file")
    ap.add_argument("names", nargs="+")
    args = ap.parse_args()
    token = load_token(args.env_file)
    if not token:
        sys.exit("No APIFY_TOKEN found.")
    for name in args.names:
        builds = call("GET", f"/acts/egra_van~{name}/builds?desc=1&limit=1", token)["items"]
        status = builds[0]["status"] if builds else "NONE"
        if status != "SUCCEEDED":
            print(f"- {name}: last build {status}, not published")
            continue
        actor = call("PUT", f"/acts/egra_van~{name}", token, {"isPublic": True})
        print(f"* {name}: public={actor.get('isPublic')} https://apify.com/egra_van/{name}")


if __name__ == "__main__":
    main()
