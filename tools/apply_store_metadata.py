#!/usr/bin/env python3
"""Apply store-metadata.json (categories, title, description, SEO title/description, example run input) to the live Actors.

actor.json has no field for categories, SEO texts or the example run input, so they are set through
the Apify API: PUT https://api.apify.com/v2/acts/{username}~{name}.

Usage:
  python3 tools/apply_store_metadata.py                      # dry run: compare with the live public data
  python3 tools/apply_store_metadata.py --env-file PATH --apply   # send the changes

The token is read from the APIFY_TOKEN environment variable or from APIFY_TOKEN=... in --env-file.
It is never printed and never passed on the command line.
"""
import argparse
import json
import os
import sys
import urllib.request

USERNAME = "egra_van"
API = "https://api.apify.com/v2/acts/"
FIELDS = ("title", "description", "categories", "seoTitle", "seoDescription", "exampleRunInput")
# Max lengths. title and description: Apify Actor marketing playbook (name 40-50 characters, description 300).
# seoTitle 60 and seoDescription 160: maxLength in the Apify OpenAPI (TaskPublicConfig); the playbook advises 40-50 and 145-155.
LIMITS = {"title": 50, "description": 300, "seoTitle": 60, "seoDescription": 160}


def too_long(cfg):
    return [f"{f} {len(cfg[f])} > {m}" for f, m in LIMITS.items() if isinstance(cfg.get(f), str) and len(cfg[f]) > m]


def load_token(env_file):
    token = os.environ.get("APIFY_TOKEN")
    if not token and env_file:
        with open(os.path.expanduser(env_file), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("APIFY_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
    return token


def request(method, url, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as res:
        return json.load(res)["data"]


def wanted(cfg):
    out = {}
    for f in FIELDS:
        if f not in cfg:
            continue
        if f == "exampleRunInput":
            out[f] = {"body": json.dumps(cfg[f], ensure_ascii=False, indent=2), "contentType": "application/json; charset=utf-8"}
        else:
            out[f] = cfg[f]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="send the changes (default: dry run)")
    ap.add_argument("--env-file", help="file with APIFY_TOKEN=...")
    ap.add_argument("--only", help="comma-separated Actor names")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    meta = json.load(open(os.path.join(here, "..", "store-metadata.json"), encoding="utf-8"))["actors"]
    only = set(args.only.split(",")) if args.only else None
    # The token is also used for reading when given, so private (unpublished) Actors can be compared too.
    token = load_token(args.env_file) if (args.apply or args.env_file) else None
    if args.apply and not token:
        sys.exit("No APIFY_TOKEN found (environment or --env-file).")

    for name, cfg in meta.items():
        if only and name not in only:
            continue
        bad = too_long(cfg)
        if bad:
            print(f"! {name}: too long: " + "; ".join(bad) + " (not applied)")
            continue
        url = f"{API}{USERNAME}~{name}"
        live = request("GET", url, token)
        body = wanted(cfg)
        changes = {}
        for k, v in body.items():
            cur = live.get(k)
            if k == "exampleRunInput":
                try:
                    same = json.loads((cur or {}).get("body") or "null") == cfg[k]
                except ValueError:
                    same = False
            else:
                same = cur == v
            if not same:
                changes[k] = v
        if not changes:
            print(f"= {name}: already up to date")
            continue
        print(f"~ {name}: " + ", ".join(changes))
        if args.apply:
            updated = request("PUT", url, token, changes)
            print(f"  applied: categories={updated.get('categories')} seoTitle={updated.get('seoTitle')!r}")


if __name__ == "__main__":
    main()
