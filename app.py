#!/usr/bin/env python3
"""听写小助手 — weekly English dictation helper.

Flow:
  1. POST /api/sessions            — upload photo of the word list -> OCR words (draft)
  2. PUT  /api/sessions/{id}       — save the corrected/confirmed word list
  3. POST /api/sessions/{id}/start — dictation started, client sends shuffled order
  4. POST /api/sessions/{id}/complete — upload photo of written answers -> grading
  5. GET  /api/sessions, /api/stats — history & weekly summary

Vision (OCR + handwriting grading) goes through any OpenAI-compatible
vision endpoint; set WD_VISION_URL (default: http://127.0.0.1:8080/v1/chat/completions).
"""
from __future__ import annotations

import base64
import difflib
import json
import os
import re
import sqlite3
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("WD_DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "dictation.db"
UPLOAD_DIR = DATA_DIR / "uploads"

VISION_URL = os.environ.get("WD_VISION_URL", "http://127.0.0.1:8080/v1/chat/completions")
VISION_MODEL = os.environ.get("WD_VISION_MODEL", "qwen3.8-flash-next-iq3_xxs")
VISION_TIMEOUT = int(os.environ.get("WD_VISION_TIMEOUT", "300"))

try:
    from zoneinfo import ZoneInfo

    TZ = ZoneInfo("Australia/Perth")
except Exception:  # Perth has no DST — fixed offset fallback
    TZ = timezone(timedelta(hours=8), "AWST")

OCR_PROMPT = (
    "This photo shows an English spelling/word list that a child must practise "
    "for a dictation test. Extract every vocabulary word that the child must "
    "dictate, in the order they appear on the page. Return ONLY a JSON array "
    "of the words in lowercase, e.g. [\"because\",\"important\"]. Ignore titles, "
    "headings, dates, week labels, numbers, bullets, teacher comments and any "
    "other non-vocabulary text. Keep each word exactly as spelled. If a word "
    "is hard to read, give your best guess. No commentary, only the JSON array."
)


def grade_prompt(words: list[str]) -> str:
    return (
        "This photo shows a child's handwritten answers for an English "
        "dictation test. The test asked for EXACTLY these words, in a random "
        f"order: {json.dumps(words)}. Transcribe every handwritten attempt "
        "preserving the child's spelling exactly (do NOT silently correct it). "
        "Ignore numbering, bullets and stray marks. For each attempt, decide "
        "which expected word the child was attempting. Return ONLY a JSON "
        "object like: {\"attempts\": [{\"written\": \"becuse\", \"expected\": "
        "\"because\", \"correct\": false}], \"missing\": [\"dangerous\"], "
        "\"notes\": \"short encouraging comment in Chinese\"}. 'missing' lists "
        "expected words with no plausible attempt. If the same word was "
        "attempted twice, include both attempts. No commentary, only the JSON "
        "object."
    )


app = FastAPI(title="听写小助手")


# --------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------

def db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sessions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                status TEXT NOT NULL DEFAULT 'draft',   -- draft | running | done
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                week TEXT NOT NULL,
                words_json TEXT NOT NULL DEFAULT '[]',
                order_json TEXT,
                results_json TEXT,
                score REAL,
                total INTEGER,
                correct_count INTEGER,
                list_photo TEXT,
                answer_photo TEXT
            );
            CREATE TABLE IF NOT EXISTS review_pool(
                word TEXT PRIMARY KEY,          -- normalized lowercase
                wrong_count INTEGER NOT NULL DEFAULT 1,
                last_wrong_at TEXT NOT NULL
            );
            """
        )


init_db()


def now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def week_of(dt: datetime) -> str:
    y, w, _ = dt.isocalendar()
    return f"{y}-W{w:02d}"


def row_json(row: sqlite3.Row) -> dict:
    d = dict(row)
    for key in ("words_json", "order_json", "results_json"):
        val = d.pop(key, None)
        short = key[: -len("_json")]
        try:
            d[short] = json.loads(val) if val else None
        except json.JSONDecodeError:
            d[short] = None
    return d


# --------------------------------------------------------------------------
# vision helpers
# --------------------------------------------------------------------------

def vision(prompt: str, image_bytes: bytes, image_type: str) -> str:
    b64 = base64.b64encode(image_bytes).decode()
    payload = {
        "model": VISION_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{image_type};base64,{b64}"},
                    },
                ],
            }
        ],
        "temperature": 0.1,
        "max_tokens": 2000,
    }
    req = urllib.request.Request(
        VISION_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=VISION_TIMEOUT) as resp:
            out = json.loads(resp.read().decode())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"视觉模型调用失败：{exc}") from exc
    try:
        return out["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as exc:
        raise HTTPException(502, f"视觉模型返回异常：{out}") from exc


def extract_json(text: str):
    t = text.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if m:
        t = m.group(1).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    for opener, closer in (("[", "]"), ("{", "}")):
        start = t.find(opener)
        if start < 0:
            continue
        depth = 0
        for i in range(start, len(t)):
            if t[i] == opener:
                depth += 1
            elif t[i] == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(t[start : i + 1])
                    except json.JSONDecodeError:
                        break
    raise HTTPException(502, f"模型没能返回可解析的 JSON：{text[:300]}")


WORD_RE = re.compile(r"^[A-Za-z][A-Za-z'’-]*$")


def sanitize_words(items) -> list[str]:
    words: list[str] = []
    seen = set()
    for raw in items:
        w = str(raw).strip().strip(").:;,*#")
        w = re.sub(r"^\s*\d+[.)]?\s*", "", w)  # strip "1." / "2)" prefixes
        w = w.replace("’", "'").lower()
        if not WORD_RE.match(w):
            continue
        if w in seen:
            continue
        seen.add(w)
        words.append(w)
    return words


def norm(word: str) -> str:
    return re.sub(r"[^a-z'-]", "", str(word).lower().replace("’", "'"))


# --------------------------------------------------------------------------
# API models
# --------------------------------------------------------------------------

class WordsIn(BaseModel):
    words: list[str]


class OrderIn(BaseModel):
    order: list[str]


def get_session(conn: sqlite3.Connection, sid: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
    if row is None:
        raise HTTPException(404, "session not found")
    return row


def save_photo(sid: int, which: str, data: bytes, content_type: str | None) -> str:
    if not data:
        raise HTTPException(400, "empty photo")
    suffix = "jpg" if "jpeg" in (content_type or "") else "png"
    rel = f"{sid}/{which}.{suffix}"
    path = UPLOAD_DIR / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return rel


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

@app.post("/api/sessions")
async def create_session(photo: UploadFile = File(...)):
    """Upload a photo of the word list; OCR it into a draft session."""
    data = await photo.read()
    if not data:
        raise HTTPException(400, "empty photo")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(400, "photo too large (>20MB)")
    text = vision(OCR_PROMPT, data, photo.content_type or "image/jpeg")
    parsed = extract_json(text)
    if not isinstance(parsed, list):
        raise HTTPException(502, f"模型返回的不是单词数组：{text[:300]}")
    words = sanitize_words(parsed)
    if not words:
        raise HTTPException(422, "照片里没能识别出单词，换一张更清晰的照片试试")
    created = now_iso()
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO sessions(status, created_at, week, words_json) VALUES('draft', ?, ?, ?)",
            (created, week_of(datetime.now(TZ)), json.dumps(words)),
        )
        sid = cur.lastrowid
    rel = save_photo(sid, "list", data, photo.content_type)
    with db() as conn:
        conn.execute("UPDATE sessions SET list_photo=? WHERE id=?", (rel, sid))
    return {"id": sid, "words": words}


@app.put("/api/sessions/{sid}")
async def update_words(sid: int, body: WordsIn):
    words = sanitize_words(body.words)
    if not words:
        raise HTTPException(400, "word list is empty")
    with db() as conn:
        get_session(conn, sid)
        conn.execute(
            "UPDATE sessions SET words_json=? WHERE id=?", (json.dumps(words), sid)
        )
    return {"id": sid, "words": words}


@app.post("/api/sessions/{sid}/start")
async def start_session(sid: int, body: OrderIn):
    with db() as conn:
        row = get_session(conn, sid)
        expected = sorted(json.loads(row["words_json"] or "[]"))
        order = sorted([norm(w) for w in body.order])
        if expected != order:
            raise HTTPException(400, "shuffled order does not match the word list")
        conn.execute(
            "UPDATE sessions SET status='running', started_at=?, order_json=? WHERE id=?",
            (now_iso(), json.dumps(body.order), sid),
        )
    return {"id": sid, "started": True}


@app.post("/api/sessions/{sid}/complete")
async def complete_session(sid: int, photo: UploadFile = File(...)):
    with db() as conn:
        row = get_session(conn, sid)
        if row["status"] == "draft":
            raise HTTPException(400, "dictation has not started yet")
        words = json.loads(row["words_json"] or "[]")

    data = await photo.read()
    if not data:
        raise HTTPException(400, "empty photo")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(400, "photo too large (>20MB)")

    text = vision(grade_prompt(words), data, photo.content_type or "image/jpeg")
    parsed = extract_json(text)
    if not isinstance(parsed, dict):
        raise HTTPException(502, f"判分结果格式异常：{text[:300]}")

    word_set = {norm(w): w for w in words}
    attempts_out = []
    for att in parsed.get("attempts", []) or []:
        written = str(att.get("written", "")).strip()
        wn = norm(written)
        if not wn:
            continue
        expected = word_set.get(norm(att.get("expected", "")))
        if expected is None and wn:  # model failed to map — guess closest word
            cand = difflib.get_close_matches(wn, list(word_set), n=1, cutoff=0.55)
            expected = word_set[cand[0]] if cand else None
        correct = expected is not None and wn == norm(expected)
        attempts_out.append(
            {
                "written": written,
                "expected": expected or att.get("expected"),
                "correct": bool(correct),
            }
        )
    correct_words = {norm(a["expected"]) for a in attempts_out if a["correct"] and a["expected"]}
    mapped_words = {norm(a["expected"]) for a in attempts_out if a["expected"]}
    missing = [w for w in words if norm(w) not in mapped_words]
    total = len(words)
    distinct_correct = len(correct_words)
    score = distinct_correct / total if total else 0.0
    results = {
        "attempts": attempts_out,
        "missing": missing,
        "notes": str(parsed.get("notes", "")),
    }
    rel = save_photo(sid, "answer", data, photo.content_type)
    completed = now_iso()

    # 复习池：本次写错/漏写的词进池（计数+1）；本次写对且不在错列里的池词毕业出池。
    wrong_norm = {norm(a["expected"]) for a in attempts_out if not a["correct"] and a["expected"]}
    wrong_norm |= {norm(w) for w in missing}
    graduate_norm = correct_words - wrong_norm

    with db() as conn:
        pool_words = {r["word"] for r in conn.execute("SELECT word FROM review_pool")}
        review_added = []
        for wn in sorted(wrong_norm):
            conn.execute(
                "INSERT INTO review_pool(word, wrong_count, last_wrong_at) VALUES(?, 1, ?) "
                "ON CONFLICT(word) DO UPDATE SET wrong_count=wrong_count+1, last_wrong_at=excluded.last_wrong_at",
                (wn, completed),
            )
            review_added.append(word_set.get(wn, wn))
        review_graduated = []
        for wn in sorted(graduate_norm & pool_words):
            conn.execute("DELETE FROM review_pool WHERE word=?", (wn,))
            review_graduated.append(word_set.get(wn, wn))
        results["review_added"] = review_added
        results["review_graduated"] = review_graduated
        conn.execute(
            "UPDATE sessions SET status='done', completed_at=?, results_json=?, score=?, "
            "total=?, correct_count=?, answer_photo=? WHERE id=?",
            (completed, json.dumps(results), round(score, 4), total, distinct_correct, rel, sid),
        )
    return {
        "id": sid,
        "score": round(score * 100, 1),
        "total": total,
        "correct_count": distinct_correct,
        "results": results,
        "review_added": review_added,
        "review_graduated": review_graduated,
    }


@app.get("/api/sessions")
async def list_sessions(status: str = "all", limit: int = 100):
    with db() as conn:
        if status == "all":
            rows = conn.execute(
                "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE status=? ORDER BY created_at DESC LIMIT ?",
                (status, limit),
            ).fetchall()
    return [row_json(r) for r in rows]


@app.get("/api/sessions/{sid}")
async def get_session_detail(sid: int):
    with db() as conn:
        row = get_session(conn, sid)
    return row_json(row)


@app.get("/api/sessions/{sid}/photo/{which}")
async def session_photo(sid: int, which: str):
    if which not in ("list", "answer"):
        raise HTTPException(400, "bad photo name")
    with db() as conn:
        row = get_session(conn, sid)
    rel = row["list_photo"] if which == "list" else row["answer_photo"]
    if not rel:
        raise HTTPException(404, "no photo")
    path = UPLOAD_DIR / rel
    if not path.exists():
        raise HTTPException(404, "photo file missing")
    return FileResponse(path)


@app.delete("/api/sessions/{sid}")
async def delete_session(sid: int):
    with db() as conn:
        row = get_session(conn, sid)
        conn.execute("DELETE FROM sessions WHERE id=?", (sid,))
    for which in ("list_photo", "answer_photo"):
        rel = row[which]
        if rel:
            p = UPLOAD_DIR / rel
            if p.exists():
                p.unlink()
    return {"deleted": sid}


@app.get("/api/stats")
async def stats():
    now = datetime.now(TZ)
    current_week = week_of(now)
    with db() as conn:
        rows = conn.execute(
            "SELECT week, COUNT(*) n, AVG(score) avg_score, MAX(completed_at) last_done "
            "FROM sessions WHERE status='done' GROUP BY week ORDER BY week DESC LIMIT 26"
        ).fetchall()
    weeks = [dict(r) for r in rows]
    current_done = any(w["week"] == current_week for w in weeks)
    review_n = 0
    with db() as conn:
        review_n = conn.execute("SELECT COUNT(*) c FROM review_pool").fetchone()["c"]
    return {
        "current_week": current_week,
        "current_week_done": current_done,
        "weeks": weeks,
        "review_count": review_n,
    }


@app.get("/api/review")
async def review_list():
    with db() as conn:
        rows = conn.execute(
            "SELECT word, wrong_count, last_wrong_at FROM review_pool ORDER BY last_wrong_at DESC"
        ).fetchall()
    return {"words": [dict(r) for r in rows]}


@app.delete("/api/review/{word}")
async def review_delete(word: str):
    wn = norm(word)
    if not wn:
        raise HTTPException(400, "invalid word")
    with db() as conn:
        cur = conn.execute("DELETE FROM review_pool WHERE word=?", (wn,))
        n = cur.rowcount
    return {"deleted": n}


app.mount("/", StaticFiles(directory=BASE_DIR / "static", html=True), name="static")
