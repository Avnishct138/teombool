#!/usr/bin/env python3
"""
Crawl the live teom Worker and rebuild public/ with exactly the files that the
deployed ASSETS binding serves.

Distinguishing rule (verified against the live site):
  • static asset  → response has an `etag` + `cf-cache-status` header
  • embedded page → `cache-control: public, max-age=300` + `x-content-type-options: nosniff`
                     (those live inside src/original-teom.mjs and survive a deploy)

Only the static assets are downloaded — the embedded pages are already in the
preserved worker bundle.
"""
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ORIGIN = "https://teom.avnishchandrathapliyal.workers.dev"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/teom/public"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

SKIP_PREFIXES = (
    "/api/", "/admin/", "/s/", "/community/", "/hi/teombool/api/",
    "/api/chat", "/api/agni",
)
SEEDS = [
    "/", "/robots.txt", "/jit.html", "/index.html",
    "/metadata/jit.json", "/metadata/jit.md",
    "/assets/teom_learning_curves.png",
]

seen = set()
queue = list(SEEDS)
assets = {}
embedded = []
failed = []


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.status, dict(response.headers), response.read()


def is_asset(headers):
    return "etag" in {k.lower() for k in headers}


def local_path(url_path):
    path = urllib.parse.unquote(url_path)
    if path.endswith("/"):
        path += "index.html"
    if path == "":
        path = "/index.html"
    if "." not in os.path.basename(path):
        path += ".html"
    return os.path.join(OUT, path.lstrip("/"))


def discover(html_text, base):
    found = set()
    for match in re.findall(r'(?:href|src)=["\']([^"\'#]+)["\']', html_text):
        found.add(match)
    for match in re.findall(r'url\((["\']?)([^)"\']+)\1\)', html_text):
        found.add(match[1])
    for match in re.findall(r'["\'](/[A-Za-z0-9_./\-ऀ-ॿ]+\.(?:html|css|js|json|md|png|jpg|jpeg|svg|webp|ico|txt|xml))["\']', html_text):
        found.add(match)
    resolved = set()
    for item in found:
        if item.startswith(("http://", "https://", "mailto:", "data:", "javascript:")):
            continue
        resolved.add(urllib.parse.urljoin(base, item).split("#")[0])
    return resolved


while queue:
    current = queue.pop(0)
    if current in seen:
        continue
    seen.add(current)
    url = current if current.startswith("http") else ORIGIN + current
    path = urllib.parse.urlparse(url).path
    if any(path.startswith(p) for p in SKIP_PREFIXES):
        continue
    try:
        status, headers, body = fetch(url)
    except urllib.error.HTTPError as error:
        failed.append((path, error.code))
        continue
    except Exception as error:  # noqa: BLE001
        failed.append((path, str(error)[:60]))
        continue

    if is_asset(headers):
        assets[path] = body
        content_type = headers.get("Content-Type", "")
        if "html" in content_type or "javascript" in content_type or "json" in content_type or "css" in content_type:
            text = body.decode("utf-8", "replace")
            for found in discover(text, url):
                if found not in seen:
                    queue.append(found)
    else:
        embedded.append(path)
        text = body.decode("utf-8", "replace")
        for found in discover(text, url):
            if found not in seen:
                queue.append(found)

print(f"crawled {len(seen)} urls")
print(f"assets found : {len(assets)}")
for path in sorted(assets):
    print(f"   {path}  ({len(assets[path])} bytes)")
print(f"embedded pages (kept inside the preserved worker): {len(embedded)}")
for path in sorted(embedded):
    print(f"   {path}")
if failed:
    print("non-200 during crawl:")
    for path, code in sorted(set(failed)):
        print(f"   {path} -> {code}")

if "--write" in sys.argv:
    for path, body in assets.items():
        destination = local_path(path)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with open(destination, "wb") as handle:
            handle.write(body)
        print("saved", destination)
