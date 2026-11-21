#!/usr/bin/env python3
"""Mobile check: launcher → panel → settings window on a phone viewport."""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://teom.avnishchandrathapliyal.workers.dev"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/workspace/teom/docs/screenshots"
CHROME = os.environ.get("CHROME_PATH", "/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome")
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(f"{BASE}/hi/agni/lab", wait_until="networkidle")
    page.wait_for_timeout(1500)
    print("launcher button:", page.query_selector("#agni-assistant-toggle") is not None)
    page.click("#agni-assistant-toggle")
    page.wait_for_timeout(700)
    print("panel open:", not page.eval_on_selector("#agni-assistant-panel", "el => el.hidden"))
    print("gear button visible:", page.query_selector("#agni-assistant-settings") is not None
          and page.is_visible("#agni-assistant-settings"))
    page.click("#agni-assistant-settings")
    page.wait_for_timeout(600)
    print("settings window visible:", page.is_visible("#agni-assistant-settings-window"))
    print("api key field visible:", page.is_visible("#agni-assistant-api-key"))
    overflow = page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 2")
    print("horizontal overflow:", overflow)
    page.screenshot(path=f"{OUT}/agni-assistant-settings-mobile.png")
    print("errors:", errors[:4])
    browser.close()
