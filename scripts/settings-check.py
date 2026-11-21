#!/usr/bin/env python3
"""Check the assistant settings window: open, fill key, save, verify it is used."""
import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8789"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/workspace/teom/docs/screenshots"
CHROME = os.environ.get("CHROME_PATH", "/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome")
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    captured = []
    page.on("request", lambda r: captured.append(r) if "/api/agni/assistant/chat" in r.url else None)

    page.goto(f"{BASE}/hi/agni/lab", wait_until="networkidle")
    page.wait_for_timeout(1200)
    page.click("#agni-assistant-toggle")
    page.wait_for_timeout(400)

    page.click("#agni-assistant-settings")
    page.wait_for_timeout(400)
    print("settings window open:", not page.eval_on_selector("#agni-assistant-settings-window", "el => el.hidden"))
    page.fill("#agni-assistant-api-key", "sk-test-user-key-999")
    page.select_option("#agni-assistant-base-url", "https://api.xkiro.com/v1")
    page.fill("#agni-assistant-model", "mistralai/mistral-small-2603")
    page.screenshot(path=f"{OUT}/agni-assistant-settings.png")
    page.click("#agni-assistant-settings-save")
    page.wait_for_timeout(300)
    print("settings status:", page.inner_text("#agni-assistant-settings-status"))
    page.click("#agni-assistant-settings-close")
    page.wait_for_timeout(300)
    print("window closed:", page.eval_on_selector("#agni-assistant-settings-window", "el => el.hidden"))
    print("chips:", page.eval_on_selector_all("#agni-assistant-context .agni-assistant-chip", "els => els.map(e => e.textContent)"))

    # send a message and confirm the request carried the key
    question = page.inner_text("#agni-assistant-challenge-question")
    numbers = re.findall(r"\d+", question)
    page.fill("#agni-assistant-challenge-answer", str(sum(int(n) for n in numbers[:2])))
    page.fill("#agni-assistant-input", "नमस्ते, एक forward pass चला कर बताओ")
    page.click("#agni-assistant-send")
    deadline = time.time() + 120
    while time.time() < deadline:
        if not page.eval_on_selector("#agni-assistant-send", "el => el.disabled"):
            break
        time.sleep(1)
    page.wait_for_timeout(1500)

    posted = [r for r in captured if r.method == "POST"]
    if posted:
        body = posted[-1].post_data or ""
        print("request carried apiKey:", "sk-test-user-key-999" in body)
        print("request carried baseUrl:", "api.xkiro.com" in body)
    print("last bubble:", page.query_selector_all("#agni-assistant-messages .agni-assistant-bubble")[-1].inner_text()[:160].replace("\n", " "))
    print("page errors:", errors[:5])
    browser.close()
