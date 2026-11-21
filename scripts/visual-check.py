#!/usr/bin/env python3
"""Visual check of the AGNi Development Assistant panel (local dev server)."""
import sys
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/workspace/teom/docs/screenshots"

import os
os.makedirs(OUT, exist_ok=True)

CHROME = os.environ.get("CHROME_PATH", "/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome")

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

    page.goto(f"{BASE}/hi/agni/lab", wait_until="networkidle")
    page.wait_for_timeout(1500)
    # open the assistant panel
    toggle = page.query_selector("#agni-assistant-toggle")
    if toggle:
        toggle.click()
        page.wait_for_timeout(800)
    page.screenshot(path=f"{OUT}/agni-lab-assistant.png", full_page=False)
    print("panel visible:", page.query_selector("#agni-assistant-panel") is not None)
    print("context chips:", page.eval_on_selector_all("#agni-assistant-context *", "els => els.length"))
    print("challenge text:", page.eval_on_selector("#agni-assistant-challenge-question", "el => el.textContent.trim()"))
    print("nexi svg:", page.query_selector("#agni-assistant-nexi svg") is not None)
    print("console errors:", errors[:8])

    page.goto(f"{BASE}/hi/agni", wait_until="networkidle")
    page.wait_for_timeout(1200)
    t = page.query_selector("#agni-assistant-toggle")
    if t:
        t.click()
        page.wait_for_timeout(600)
    page.screenshot(path=f"{OUT}/agni-page-assistant.png")
    print("legacy chat still present:", page.query_selector("#agni-ai-chat") is not None)

    # mobile viewport
    mobile = browser.new_page(viewport={"width": 390, "height": 844})
    mobile.goto(f"{BASE}/hi/agni/lab", wait_until="networkidle")
    mobile.wait_for_timeout(1200)
    t = mobile.query_selector("#agni-assistant-toggle")
    if t:
        t.click()
        mobile.wait_for_timeout(600)
    mobile.screenshot(path=f"{OUT}/agni-lab-assistant-mobile.png")
    overflow = mobile.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 2")
    print("mobile horizontal overflow:", overflow)
    browser.close()
