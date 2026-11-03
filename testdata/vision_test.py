#!/usr/bin/env python3
"""Quick probe of the vision endpoint with a word-list image (testdata helper)."""
import base64
import json
import os
import sys
import urllib.request

BASE = os.environ.get("WD_VISION_URL", "http://127.0.0.1:8080/v1/chat/completions")
MODEL = os.environ.get("WD_VISION_MODEL", "qwen3.8-flash-next-iq3_xxs")

def ask(image_path: str, prompt: str):
    data = base64.b64encode(open(image_path, "rb").read()).decode()
    payload = {
        "model": MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{data}"}},
            ],
        }],
        "temperature": 0.1,
        "max_tokens": 1200,
    }
    req = urllib.request.Request(
        BASE, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        out = json.loads(r.read().decode())
    return out["choices"][0]["message"]["content"]

if __name__ == "__main__":
    img = sys.argv[1]
    prompt = sys.argv[2]
    print(ask(img, prompt))
