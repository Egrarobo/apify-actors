#!/usr/bin/env python3
"""Create (and optionally publish) the public Actor tasks from tasks/public-tasks.json.

  python3 tools/publish_tasks.py                         # dry run: list what would be created
  python3 tools/publish_tasks.py --env-file PATH --create # create/update the tasks, PRIVATE, with page details
  python3 tools/publish_tasks.py --env-file PATH --run    # run every task once (a task must work before publishing)
  python3 tools/publish_tasks.py --env-file PATH --publish  # set isPublic = true (public landing pages)

Each step only touches tasks named in the JSON. --only name1,name2 limits it further.
The token is read from APIFY_TOKEN or from APIFY_TOKEN=... in --env-file; it is never printed.
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
    token = os.environ.get("APIFY_TOKEN")
    if not token and env_file:
        with open(os.path.expanduser(env_file), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("APIFY_TOKEN="):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
    return token


def call(method, path, token, body=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {token}")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.load(res).get("data")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code >= 500 and attempt < 4:  # Apify gateway hiccups (502/503) are transient
                time.sleep(5 * (attempt + 1))
                continue
            raise SystemExit(f"{method} {path}: HTTP {e.code} {e.read().decode()[:300]}")
        except urllib.error.URLError:
            if attempt < 4:
                time.sleep(5 * (attempt + 1))
                continue
            raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--env-file")
    ap.add_argument("--create", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--publish", action="store_true")
    ap.add_argument("--only")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    tasks = json.load(open(os.path.join(here, "..", "tasks", "public-tasks.json"), encoding="utf-8"))
    if args.only:
        keep = set(args.only.split(","))
        tasks = [t for t in tasks if t["name"] in keep]

    if not (args.create or args.run or args.publish):
        for t in tasks:
            print(f"- {t['actor']} :: {t['name']} :: {t['title']} ({t['cost']})")
        print(f"{len(tasks)} task(s). Dry run: nothing sent.")
        return

    token = load_token(args.env_file)
    if not token:
        sys.exit("No APIFY_TOKEN found (environment or --env-file).")
    me = call("GET", "/users/me", token)["username"]

    for t in tasks:
        task_ref = f"{me}~{t['name']}"
        page = {
            "title": t["title"],
            "description": t["description"],
            "publicConfig": {
                "seoTitle": t["seoTitle"],
                "seoDescription": t["seoDescription"],
                "inputSchemaFields": t["fields"],
                "datasetView": t["view"],
            },
        }
        if args.create:
            existing = call("GET", f"/actor-tasks/{task_ref}", token)
            if existing:
                call("PUT", f"/actor-tasks/{existing['id']}", token, {**page, "input": t["input"]})
                print(f"~ updated {t['name']}")
            else:
                actor = call("GET", f"/acts/{t['actor'].replace('/', '~')}", token)
                created = call("POST", "/actor-tasks", token, {"actId": actor["id"], "name": t["name"], "input": t["input"]})
                call("PUT", f"/actor-tasks/{created['id']}", token, page)
                print(f"+ created {t['name']} (private)")
        if args.run:
            run = call("POST", f"/actor-tasks/{task_ref}/runs", token, {})
            while run["status"] in ("READY", "RUNNING"):
                time.sleep(10)
                run = call("GET", f"/actor-runs/{run['id']}", token)
            items = call("GET", f"/datasets/{run['defaultDatasetId']}", token) or {}
            print(f"  run {t['name']}: {run['status']}, {items.get('itemCount', '?')} item(s)")
        if args.publish:
            call("PUT", f"/actor-tasks/{task_ref}", token, {"isPublic": True})
            print(f"* published {t['name']}")


if __name__ == "__main__":
    main()
