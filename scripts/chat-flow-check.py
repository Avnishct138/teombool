#!/usr/bin/env python3
"""Interactive browser check: send a message, run a tool, approve a preview."""
import os
import re
import time
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8789"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/workspace/teom/docs/screenshots"
CHROME = os.environ.get("CHROME_PATH", "/root/.cache/ms-playwright/chromium-1243/chrome-linux/chrome")
os.makedirs(OUT, exist_ok=True)

MESSAGE = "एक SGD training step propose करो (target index 0, learning rate 0.05) और preview दिखाओ"

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    page.goto(f"{BASE}/hi/agni/lab", wait_until="networkidle")
    page.wait_for_timeout(1200)
    page.click("#agni-assistant-toggle")
    page.wait_for_timeout(500)

    # solve the human-check challenge
    question = page.inner_text("#agni-assistant-challenge-question")
    numbers = re.findall(r"\d+", question)
    answer = str(sum(int(n) for n in numbers[:2]))
    print("challenge:", question, "→", answer)
    page.fill("#agni-assistant-challenge-answer", answer)

    page.fill("#agni-assistant-input", MESSAGE)
    page.click("#agni-assistant-send")

    # wait until the request finishes (send button becomes enabled again)
    deadline = time.time() + 150
    while time.time() < deadline:
        busy = page.eval_on_selector("#agni-assistant-send", "el => el.disabled")
        if not busy:
            break
        time.sleep(1)
    page.wait_for_timeout(2000)

    bubbles = page.query_selector_all("#agni-assistant-messages .agni-assistant-bubble")
    print("bubbles:", len(bubbles))
    for bubble in bubbles[-3:]:
        text = bubble.inner_text().replace("\n", " ")[:220]
        print("  ·", text)

    tools = page.query_selector_all("#agni-assistant-tools .agni-assistant-tool")
    print("tool rows:", [(t.inner_text().replace("\n", " ")[:70]) for t in tools])

    proposals = page.query_selector_all("#agni-assistant-preview .agni-assistant-proposal")
    print("proposal blocks:", len(proposals))

    if proposals:
        diff_lines = page.query_selector_all("#agni-assistant-preview .agni-assistant-diff-line")
        print("diff rows shown:", len(diff_lines))
        approve = page.query_selector("#agni-assistant-preview .agni-assistant-approve")
        print("approve button:", approve is not None)
        before = page.eval_on_selector("#w2", "el => el.value")
        approve.click()
        page.wait_for_timeout(2500)
        after = page.eval_on_selector("#w2", "el => el.value")
        print("weights textarea changed after approve:", before != after)
        print("status line:", page.inner_text("#agni-assistant-status")[:160])
        last = page.query_selector_all("#agni-assistant-messages .agni-assistant-bubble")
        print("last bubble:", last[-1].inner_text().replace("\n", " ")[:220])

    page.screenshot(path=f"{OUT}/agni-assistant-conversation.png")
    print("page errors:", errors[:5])
    browser.close()
