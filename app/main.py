"""Pixelizer — a pixelated-image multiple-choice guessing game.

Builders upload images, pick a pixelation resolution per image, and define
multiple-choice options. Players get a share link, guess each pixelated image,
and land on a leaderboard. Pixelation happens server-side so the crisp image is
never sent to a player before they answer.
"""

import io
import json
import os
import secrets
import sqlite3
import time
from pathlib import Path

from authlib.integrations.starlette_client import OAuth, OAuthError
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from starlette.middleware.sessions import SessionMiddleware

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
UPLOADS = DATA / "uploads"
CACHE = DATA / "cache"
STATIC = BASE / "static"
DB_PATH = DATA / "games.db"
for d in (DATA, UPLOADS, CACHE):
    d.mkdir(parents=True, exist_ok=True)

SERVE_MAX = 1100  # side (px) of the square each served image is cropped to
MIN_BLOCKS, MAX_BLOCKS = 3, 160  # pixelation resolution bounds (blocks across)
IMG_VER = "sq1"  # bump to invalidate the on-disk image cache when processing changes

# --------------------------------------------------------------------- auth cfg
load_dotenv(BASE / ".env")
SECRET_KEY = os.environ.get("SECRET_KEY") or "dev-insecure-change-me"
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "")
AUTH_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
# Site-admin token: the admin page sends localStorage["12321"] as X-Admin-Token
# and the server compares against this, so the value never ships in served JS.
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN") or "aoeisrtn9102"

# Version stamp shown in the page footer so a deploy is visibly confirmable.
# The start time changes on every deploy (the process restarts); the git short
# SHA is a best-effort extra that's absent in images built without .git.
APP_STARTED = time.strftime("%Y-%m-%d %H:%M", time.gmtime())


def _app_version() -> str:
    v = os.environ.get("APP_VERSION", "").strip()
    if v:
        return v
    try:
        import subprocess
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=BASE, capture_output=True, text=True, timeout=2,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:
        pass
    return ""


APP_VERSION = _app_version()

app = FastAPI(title="Pixelizer")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY, same_site="lax", https_only=False)

oauth = OAuth()
if AUTH_ENABLED:
    oauth.register(
        name="google",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


# --------------------------------------------------------------------------- db
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    with db() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS games (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL,
                created_at  REAL NOT NULL,
                edit_token  TEXT,
                names_json  TEXT
            );
            CREATE TABLE IF NOT EXISTS questions (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                position      INTEGER NOT NULL,
                ext           TEXT NOT NULL,
                pixel_size    INTEGER NOT NULL,
                options_json  TEXT NOT NULL,
                correct_index INTEGER NOT NULL,
                crop_x        REAL,
                crop_y        REAL
            );
            CREATE TABLE IF NOT EXISTS plays (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                name       TEXT NOT NULL,
                client_id  TEXT NOT NULL,
                score      INTEGER NOT NULL,
                total      INTEGER NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS answers (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                play_id      INTEGER NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
                question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
                chosen_index INTEGER NOT NULL,
                correct      INTEGER NOT NULL,
                chosen_name  TEXT
            );
            """
        )
        # migrations: add columns to a games table created before they existed
        cols = [r["name"] for r in c.execute("PRAGMA table_info(games)").fetchall()]
        if "edit_token" not in cols:
            c.execute("ALTER TABLE games ADD COLUMN edit_token TEXT")
        if "names_json" not in cols:
            c.execute("ALTER TABLE games ADD COLUMN names_json TEXT")
        if "owner_sub" not in cols:
            c.execute("ALTER TABLE games ADD COLUMN owner_sub TEXT")
        if "owner_name" not in cols:
            c.execute("ALTER TABLE games ADD COLUMN owner_name TEXT")
        if "answer_mode" not in cols:
            c.execute("ALTER TABLE games ADD COLUMN answer_mode TEXT")
        qcols = [r["name"] for r in c.execute("PRAGMA table_info(questions)").fetchall()]
        if "crop_x" not in qcols:  # focal point of the square crop, 0..1 (NULL -> 0.5)
            c.execute("ALTER TABLE questions ADD COLUMN crop_x REAL")
        if "crop_y" not in qcols:
            c.execute("ALTER TABLE questions ADD COLUMN crop_y REAL")
        acols = [r["name"] for r in c.execute("PRAGMA table_info(answers)").fetchall()]
        if "chosen_name" not in acols:  # actual name guessed (older rows only stored the index)
            c.execute("ALTER TABLE answers ADD COLUMN chosen_name TEXT")


init_db()


# -------------------------------------------------------------------- pixelate
def _frac(v, default: float = 0.5) -> float:
    """Clamp a crop focal fraction to [0, 1], falling back to centre."""
    try:
        return min(1.0, max(0.0, float(v)))
    except (TypeError, ValueError):
        return default


def _base_image(qid: int, ext: str, cx: float = 0.5, cy: float = 0.5) -> Image.Image:
    """Crisp image, EXIF-rotated and cropped to a square <= SERVE_MAX around the
    focal point (cx, cy) so every served image shares one aspect ratio."""
    im = Image.open(UPLOADS / f"{qid}.{ext}")
    im = (ImageOps.exif_transpose(im) or im).convert("RGB")
    side = min(min(im.size), SERVE_MAX)
    return ImageOps.fit(im, (side, side), Image.Resampling.LANCZOS,
                        centering=(_frac(cx), _frac(cy)))


def crisp_png(qid: int, ext: str, cx: float = 0.5, cy: float = 0.5) -> bytes:
    path = CACHE / f"{qid}_crisp_{IMG_VER}.png"
    if not path.exists():
        buf = io.BytesIO()
        _base_image(qid, ext, cx, cy).save(buf, "PNG")
        path.write_bytes(buf.getvalue())
    return path.read_bytes()


def pixel_png(qid: int, ext: str, blocks: int, cx: float = 0.5, cy: float = 0.5) -> bytes:
    path = CACHE / f"{qid}_pix_{IMG_VER}.png"
    if not path.exists():
        im = _base_image(qid, ext, cx, cy)  # square
        side = im.size[0]
        blocks = max(MIN_BLOCKS, min(blocks, MAX_BLOCKS))
        small = im.resize((blocks, blocks), Image.Resampling.BILINEAR)  # average per block
        out = small.resize((side, side), Image.Resampling.NEAREST)      # crisp blocks
        buf = io.BytesIO()
        out.save(buf, "PNG")
        path.write_bytes(buf.getvalue())
    return path.read_bytes()


def source_png(qid: int, ext: str) -> bytes:
    """Full (uncropped) image, EXIF-corrected and downscaled — owner-only, so the
    edit UI can re-pick the square crop against the original framing."""
    im = Image.open(UPLOADS / f"{qid}.{ext}")
    im = (ImageOps.exif_transpose(im) or im).convert("RGB")
    w, h = im.size
    scale = min(1.0, SERVE_MAX / max(w, h))
    if scale < 1.0:
        im = im.resize((round(w * scale), round(h * scale)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def bust_cache(qid: int):
    for p in CACHE.glob(f"{qid}_*.png"):  # every cached variant/version for this question
        p.unlink(missing_ok=True)


# --------------------------------------------------------------------- ownership
def require_owner(c, gid: str, token: str | None, user: dict | None = None):
    """Return the game row if the caller owns it — via edit_token or Google account."""
    g = c.execute("SELECT * FROM games WHERE id=?", (gid,)).fetchone()
    if not g:
        raise HTTPException(404, "game not found")
    if user and g["owner_sub"] and user.get("sub") == g["owner_sub"]:
        return g
    if token and token == g["edit_token"]:
        return g
    raise HTTPException(403, "not authorised to edit this game")


def _validate_opts(options: str, correct_index: int):
    opts = json.loads(options)
    if not isinstance(opts, list):
        raise HTTPException(400, "options must be a list")
    opts = [str(o).strip()[:120] for o in opts if str(o).strip()]
    if len(opts) < 2:
        raise HTTPException(400, "need at least 2 options")
    if not (0 <= correct_index < len(opts)):
        raise HTTPException(400, "correct_index out of range")
    return opts


def _ext_of(filename: str | None) -> str:
    ext = (filename or "img.png").rsplit(".", 1)[-1].lower()
    return ext if ext in ("png", "jpg", "jpeg", "webp", "gif", "bmp") else "png"


# How players answer each question: multiple-choice buttons or a dropdown.
ANSWER_MODES = ("choices", "select")


def _clean_answer_mode(v) -> str:
    m = str(v or "").strip().lower()
    return m if m in ANSWER_MODES else "choices"


def _clean_names(v) -> list[str]:
    """Coerce an incoming names pool to a deduped list of trimmed strings."""
    if not isinstance(v, list):
        return []
    out, seen = [], set()
    for n in v:
        s = str(n).strip()[:120]
        if s and s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out[:300]


# -------------------------------------------------------------------- api: auth
def current_user(request: Request) -> dict | None:
    return request.session.get("user")


@app.get("/api/me")
def whoami(request: Request):
    return {"enabled": AUTH_ENABLED, "user": current_user(request)}


@app.get("/api/version")
def version():
    return {"version": APP_VERSION, "started": APP_STARTED}


@app.get("/auth/login")
async def auth_login(request: Request, next: str = "/"):
    if not AUTH_ENABLED:
        raise HTTPException(503, "Google login is not configured on this server")
    # only same-site relative paths — never redirect off to another origin post-login
    request.session["post_login"] = next if next.startswith("/") and not next.startswith("//") else "/"
    return await oauth.google.authorize_redirect(request, request.url_for("auth_callback"))


@app.get("/auth/callback")
async def auth_callback(request: Request):
    if not AUTH_ENABLED:
        raise HTTPException(503, "Google login is not configured on this server")
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError:
        return RedirectResponse("/?login=failed")
    info = token.get("userinfo") or {}
    if not info.get("sub"):
        return RedirectResponse("/?login=failed")
    request.session["user"] = {
        "sub": info["sub"],
        "name": info.get("name") or info.get("email") or "Player",
        "email": info.get("email"),
        "picture": info.get("picture"),
    }
    return RedirectResponse(request.session.pop("post_login", "/"))


@app.get("/auth/logout")
def auth_logout(request: Request):
    request.session.pop("user", None)
    return RedirectResponse("/")


@app.get("/api/mygames")
def my_games(request: Request):
    """Games owned by the signed-in Google account (empty when not logged in)."""
    user = current_user(request)
    if not user:
        return {"games": []}
    with db() as c:
        rows = c.execute(
            "SELECT id, title, edit_token, created_at FROM games"
            " WHERE owner_sub=? ORDER BY created_at DESC",
            (user["sub"],),
        ).fetchall()
    return {"games": [dict(r) for r in rows]}


@app.get("/api/browse")
def browse():
    """Public directory of every published game (>= 1 question), newest first."""
    with db() as c:
        rows = c.execute(
            """
            SELECT g.id, g.title, g.owner_name, g.created_at,
                   (SELECT COUNT(*) FROM questions q WHERE q.game_id=g.id) AS question_count,
                   (SELECT COUNT(*) FROM plays p    WHERE p.game_id=g.id) AS play_count,
                   (SELECT id FROM questions q WHERE q.game_id=g.id
                      ORDER BY position LIMIT 1)                          AS cover_qid
            FROM games g
            ORDER BY g.created_at DESC
            LIMIT 300
            """
        ).fetchall()
    return {"games": [dict(r) for r in rows if r["question_count"] > 0]}


# ------------------------------------------------------------------- api: build
@app.post("/api/games")
def create_game(payload: dict, request: Request):
    title = (payload.get("title") or "Untitled game").strip()[:120]
    names = _clean_names(payload.get("names"))
    answer_mode = _clean_answer_mode(payload.get("answer_mode"))
    user = current_user(request)
    gid = secrets.token_hex(4)
    token = secrets.token_hex(16)
    with db() as c:
        c.execute(
            "INSERT INTO games (id, title, created_at, edit_token, names_json, owner_sub, owner_name, answer_mode)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (gid, title, time.time(), token, json.dumps(names),
             user["sub"] if user else None, user["name"] if user else None, answer_mode),
        )
    return {"id": gid, "title": title, "edit_token": token, "names": names, "answer_mode": answer_mode}


@app.post("/api/games/{gid}/questions")
async def add_question(
    gid: str,
    request: Request,
    image: UploadFile = File(...),
    pixel_size: int = Form(...),
    options: str = Form(...),
    correct_index: int = Form(...),
    token: str | None = Form(None),
    crop_x: float = Form(0.5),
    crop_y: float = Form(0.5),
):
    cx, cy = _frac(crop_x), _frac(crop_y)
    with db() as c:
        require_owner(c, gid, token, current_user(request))
        opts = _validate_opts(options, correct_index)
        ext = _ext_of(image.filename)

        pos_row = c.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM questions WHERE game_id=?",
            (gid,),
        ).fetchone()
        cur = c.execute(
            "INSERT INTO questions (game_id, position, ext, pixel_size, options_json, correct_index, crop_x, crop_y)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (gid, pos_row["p"], ext, int(pixel_size), json.dumps(opts), int(correct_index), cx, cy),
        )
        qid = cur.lastrowid
        assert qid is not None

    data = await image.read()
    (UPLOADS / f"{qid}.{ext}").write_bytes(data)
    # validate + warm the cache (raises early on a bad upload)
    try:
        pixel_png(qid, ext, int(pixel_size), cx, cy)
        crisp_png(qid, ext, cx, cy)
    except Exception:
        with db() as c:
            c.execute("DELETE FROM questions WHERE id=?", (qid,))
        raise HTTPException(400, "could not process image")
    return {"question_id": qid}


# -------------------------------------------------------------------- api: edit
@app.get("/api/games/{gid}/admin")
def admin_game(gid: str, request: Request, token: str | None = None):
    """Owner view — includes correct answers and pixel sizes for editing."""
    with db() as c:
        g = require_owner(c, gid, token, current_user(request))
        qs = c.execute(
            "SELECT id, position, ext, pixel_size, options_json, correct_index, crop_x, crop_y"
            " FROM questions WHERE game_id=? ORDER BY position",
            (gid,),
        ).fetchall()
    return {
        "id": g["id"],
        "title": g["title"],
        "edit_token": g["edit_token"],
        "names": json.loads(g["names_json"]) if g["names_json"] else [],
        "answer_mode": g["answer_mode"] or "choices",
        "questions": [
            {
                "id": q["id"],
                "position": q["position"],
                "pixel_size": q["pixel_size"],
                "options": json.loads(q["options_json"]),
                "correct_index": q["correct_index"],
                "crop_x": q["crop_x"] if q["crop_x"] is not None else 0.5,
                "crop_y": q["crop_y"] if q["crop_y"] is not None else 0.5,
            }
            for q in qs
        ],
    }


@app.patch("/api/games/{gid}")
def update_game(gid: str, payload: dict, request: Request):
    title = (payload.get("title") or "").strip()[:120]
    with db() as c:
        require_owner(c, gid, payload.get("token"), current_user(request))
        if title:
            c.execute("UPDATE games SET title=? WHERE id=?", (title, gid))
        if "names" in payload:
            c.execute("UPDATE games SET names_json=? WHERE id=?",
                      (json.dumps(_clean_names(payload.get("names"))), gid))
        if "answer_mode" in payload:
            c.execute("UPDATE games SET answer_mode=? WHERE id=?",
                      (_clean_answer_mode(payload.get("answer_mode")), gid))
    return {"ok": True}


@app.patch("/api/questions/{qid}")
async def update_question(
    qid: int,
    request: Request,
    token: str | None = Form(None),
    pixel_size: int = Form(...),
    options: str = Form(...),
    correct_index: int = Form(...),
    image: UploadFile | None = File(None),
    crop_x: float | None = Form(None),
    crop_y: float | None = Form(None),
):
    with db() as c:
        q = c.execute("SELECT * FROM questions WHERE id=?", (qid,)).fetchone()
        if not q:
            raise HTTPException(404, "question not found")
        require_owner(c, q["game_id"], token, current_user(request))
        opts = _validate_opts(options, correct_index)

    # keep the existing crop when the caller doesn't send one
    cx = _frac(crop_x if crop_x is not None else q["crop_x"])
    cy = _frac(crop_y if crop_y is not None else q["crop_y"])

    ext = q["ext"]
    new_bytes = None
    if image is not None and image.filename:
        new_bytes = await image.read()
        if new_bytes:
            new_ext = _ext_of(image.filename)
            if new_ext != ext:
                (UPLOADS / f"{qid}.{ext}").unlink(missing_ok=True)
            ext = new_ext
            (UPLOADS / f"{qid}.{ext}").write_bytes(new_bytes)

    with db() as c:
        c.execute(
            "UPDATE questions SET pixel_size=?, options_json=?, correct_index=?, ext=?, crop_x=?, crop_y=? WHERE id=?",
            (int(pixel_size), json.dumps(opts), int(correct_index), ext, cx, cy, qid),
        )

    bust_cache(qid)
    try:
        pixel_png(qid, ext, int(pixel_size), cx, cy)
        crisp_png(qid, ext, cx, cy)
    except Exception:
        raise HTTPException(400, "could not process image")
    return {"ok": True}


@app.delete("/api/questions/{qid}")
def delete_question(qid: int, request: Request, token: str | None = None):
    with db() as c:
        q = c.execute("SELECT game_id, ext FROM questions WHERE id=?", (qid,)).fetchone()
        if not q:
            raise HTTPException(404, "question not found")
        require_owner(c, q["game_id"], token, current_user(request))
        c.execute("DELETE FROM questions WHERE id=?", (qid,))
    (UPLOADS / f"{qid}.{q['ext']}").unlink(missing_ok=True)
    bust_cache(qid)
    return {"ok": True}


@app.post("/api/games/{gid}/reorder")
def reorder_questions(gid: str, payload: dict, request: Request):
    order = payload.get("order") or []
    with db() as c:
        require_owner(c, gid, payload.get("token"), current_user(request))
        for pos, qid in enumerate(order):
            c.execute(
                "UPDATE questions SET position=? WHERE id=? AND game_id=?",
                (pos, int(qid), gid),
            )
    return {"ok": True}


# -------------------------------------------------------------------- api: play
@app.get("/api/games/{gid}")
def get_game(gid: str):
    """Public game payload for players — deliberately omits correct answers."""
    with db() as c:
        g = c.execute("SELECT * FROM games WHERE id=?", (gid,)).fetchone()
        if not g:
            raise HTTPException(404, "game not found")
        qs = c.execute(
            "SELECT id, options_json FROM questions WHERE game_id=? ORDER BY position",
            (gid,),
        ).fetchall()
    mode = g["answer_mode"] or "choices"
    resp = {
        "id": g["id"],
        "title": g["title"],
        "answer_mode": mode,
        "questions": [
            {"id": q["id"], "options": json.loads(q["options_json"])} for q in qs
        ],
    }
    # The dropdown lists the whole name pool, so it's sent to players; buttons
    # mode deliberately omits it so the full answer set isn't exposed.
    if mode == "select":
        resp["names"] = json.loads(g["names_json"]) if g["names_json"] else []
    return resp


@app.get("/api/questions/{qid}/pixel.png")
def get_pixel(qid: int):
    with db() as c:
        q = c.execute("SELECT ext, pixel_size, crop_x, crop_y FROM questions WHERE id=?", (qid,)).fetchone()
    if not q:
        raise HTTPException(404, "not found")
    return Response(pixel_png(qid, q["ext"], q["pixel_size"], q["crop_x"], q["crop_y"]),
                    media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/questions/{qid}/crisp.png")
def get_crisp(qid: int):
    with db() as c:
        q = c.execute("SELECT ext, crop_x, crop_y FROM questions WHERE id=?", (qid,)).fetchone()
    if not q:
        raise HTTPException(404, "not found")
    return Response(crisp_png(qid, q["ext"], q["crop_x"], q["crop_y"]),
                    media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/questions/{qid}/source.png")
def get_source(qid: int, request: Request, token: str | None = None):
    """Uncropped original for the owner's crop editor — never exposed to players."""
    with db() as c:
        q = c.execute("SELECT game_id, ext FROM questions WHERE id=?", (qid,)).fetchone()
        if not q:
            raise HTTPException(404, "not found")
        require_owner(c, q["game_id"], token, current_user(request))
    return Response(source_png(qid, q["ext"]), media_type="image/png",
                    headers={"Cache-Control": "no-store"})


@app.get("/api/questions/{qid}/answer")
def get_answer(qid: int):
    """Correct option for one question — used to reveal after the player has guessed."""
    with db() as c:
        q = c.execute("SELECT correct_index FROM questions WHERE id=?", (qid,)).fetchone()
    if not q:
        raise HTTPException(404, "not found")
    return {"correct_index": q["correct_index"]}


@app.post("/api/games/{gid}/plays")
def submit_play(gid: str, payload: dict):
    name = (payload.get("name") or "Anonymous").strip()[:40] or "Anonymous"
    client_id = (payload.get("client_id") or "").strip()[:80]
    submitted = payload.get("answers") or []  # [{question_id, chosen_index, chosen_name}]

    with db() as c:
        g = c.execute("SELECT id FROM games WHERE id=?", (gid,)).fetchone()
        if not g:
            raise HTTPException(404, "game not found")
        qrows = c.execute(
            "SELECT id, options_json, correct_index FROM questions WHERE game_id=? ORDER BY position",
            (gid,),
        ).fetchall()
        chosen = {int(a["question_id"]): int(a["chosen_index"]) for a in submitted}
        picked_name = {int(a["question_id"]): str(a["chosen_name"]).strip()[:120]
                       for a in submitted if a.get("chosen_name")}

        score = 0
        graded = []
        for q in qrows:
            pick = chosen.get(q["id"], -1)
            ok = 1 if pick == q["correct_index"] else 0
            score += ok
            opts = json.loads(q["options_json"])
            # prefer the name the client sent; fall back to the option it indexes
            nm = picked_name.get(q["id"]) or (opts[pick] if 0 <= pick < len(opts) else None)
            graded.append((q["id"], pick, ok, nm))

        total = len(qrows)
        cur = c.execute(
            "INSERT INTO plays (game_id, name, client_id, score, total, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (gid, name, client_id, score, total, time.time()),
        )
        pid = cur.lastrowid
        c.executemany(
            "INSERT INTO answers (play_id, question_id, chosen_index, correct, chosen_name) VALUES (?,?,?,?,?)",
            [(pid, qid_, pick, ok, nm) for (qid_, pick, ok, nm) in graded],
        )

    reveal = [
        {
            "question_id": q["id"],
            "correct_index": q["correct_index"],
            "options": json.loads(q["options_json"]),
            "your_index": chosen.get(q["id"], -1),
        }
        for q in qrows
    ]
    return {"score": score, "total": total, "reveal": reveal,
            "leaderboard": _leaderboard(gid)}


# ------------------------------------------------------------------- api: admin
def require_admin(request: Request):
    """404 rather than 403 on a bad token, so the admin surface is invisible to probing."""
    if request.headers.get("X-Admin-Token") != ADMIN_TOKEN:
        raise HTTPException(404, "not found")


@app.get("/api/admin/games")
def admin_list_games(request: Request):
    """Every game — including unpublished zero-question ones browse hides."""
    require_admin(request)
    with db() as c:
        rows = c.execute(
            """
            SELECT g.id, g.title, g.owner_name, g.created_at,
                   (SELECT COUNT(*) FROM questions q WHERE q.game_id=g.id) AS question_count,
                   (SELECT COUNT(*) FROM plays p    WHERE p.game_id=g.id) AS play_count,
                   (SELECT id FROM questions q WHERE q.game_id=g.id
                      ORDER BY position LIMIT 1)                          AS cover_qid
            FROM games g
            ORDER BY g.created_at DESC
            """
        ).fetchall()
    return {"games": [dict(r) for r in rows]}


@app.delete("/api/admin/plays/{play_id}")
def admin_delete_play(play_id: int, request: Request):
    """Remove a single leaderboard entry (and its answers) — admin only."""
    require_admin(request)
    with db() as c:
        p = c.execute("SELECT id FROM plays WHERE id=?", (play_id,)).fetchone()
        if not p:
            raise HTTPException(404, "play not found")
        c.execute("DELETE FROM plays WHERE id=?", (play_id,))  # CASCADE clears its answers
    return {"ok": True}


@app.delete("/api/admin/games/{gid}")
def admin_delete_game(gid: str, request: Request):
    require_admin(request)
    with db() as c:
        g = c.execute("SELECT id FROM games WHERE id=?", (gid,)).fetchone()
        if not g:
            raise HTTPException(404, "game not found")
        qs = c.execute("SELECT id, ext FROM questions WHERE game_id=?", (gid,)).fetchall()
        c.execute("DELETE FROM games WHERE id=?", (gid,))  # CASCADE clears questions/plays/answers
    for q in qs:
        (UPLOADS / f"{q['id']}.{q['ext']}").unlink(missing_ok=True)
        bust_cache(q["id"])
    return {"ok": True}


# ------------------------------------------------------------------- api: stats
def _leaderboard(gid: str):
    with db() as c:
        rows = c.execute(
            "SELECT id, name, score, total, created_at FROM plays WHERE game_id=?"
            " ORDER BY score DESC, created_at ASC LIMIT 100",
            (gid,),
        ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/games/{gid}/stats")
def get_stats(gid: str):
    with db() as c:
        g = c.execute("SELECT * FROM games WHERE id=?", (gid,)).fetchone()
        if not g:
            raise HTTPException(404, "game not found")
        qrows = c.execute(
            "SELECT id, options_json, correct_index FROM questions WHERE game_id=? ORDER BY position",
            (gid,),
        ).fetchall()
        play_count = c.execute(
            "SELECT COUNT(*) n FROM plays WHERE game_id=?", (gid,)
        ).fetchone()["n"]

        questions = []
        for q in qrows:
            opts = json.loads(q["options_json"])
            counts = [0] * len(opts)
            correct_name = opts[q["correct_index"]] if 0 <= q["correct_index"] < len(opts) else None
            arows = c.execute(
                "SELECT chosen_index, chosen_name, correct, COUNT(*) n FROM answers"
                " WHERE question_id=? GROUP BY chosen_index, chosen_name, correct",
                (q["id"],),
            ).fetchall()
            answered = 0    # every recorded guess, including dropdown picks outside these options
            correct_n = 0
            guess_map = {}  # name -> {"name","count","correct"}
            for a in arows:
                answered += a["n"]
                if a["correct"]:
                    correct_n += a["n"]
                idx = a["chosen_index"]
                if 0 <= idx < len(counts):
                    counts[idx] += a["n"]
                # resolve the actual name guessed; older rows without a stored name
                # keep the option they indexed, or fall back to an "other" bucket
                if a["chosen_name"]:
                    name = a["chosen_name"]
                elif 0 <= idx < len(opts):
                    name = opts[idx]
                else:
                    name = "Other"  # older dropdown picks whose name wasn't recorded
                e = guess_map.setdefault(name, {"name": name, "count": 0, "correct": bool(a["correct"])})
                e["count"] += a["n"]
                e["correct"] = e["correct"] or bool(a["correct"])
            # always surface the correct answer, even if nobody picked it
            if correct_name and correct_name not in guess_map:
                guess_map[correct_name] = {"name": correct_name, "count": 0, "correct": True}
            guesses = sorted(guess_map.values(),
                             key=lambda x: (-x["count"], not x["correct"], x["name"].lower()))
            questions.append(
                {
                    "id": q["id"],
                    "options": opts,
                    "correct_index": q["correct_index"],
                    "counts": counts,
                    "answered": answered,
                    # guesses of a pool name that isn't one of these options (dropdown mode)
                    "other": answered - sum(counts),
                    "pct_correct": round(100 * correct_n / answered) if answered else 0,
                    "guesses": guesses,
                }
            )
    return {
        "id": g["id"],
        "title": g["title"],
        "play_count": play_count,
        "questions": questions,
        "leaderboard": _leaderboard(gid),
    }


# ------------------------------------------------------------------------ pages
def _page(name: str) -> FileResponse:
    return FileResponse(STATIC / name)


@app.get("/")
def index():
    return _page("index.html")


@app.get("/browse")
def browse_page():
    return _page("browse.html")


@app.get("/admin")
def admin_panel_page():
    return _page("admin.html")


@app.get("/g/{gid}")
def play_page(gid: str):
    return _page("play.html")


@app.get("/g/{gid}/results")
def results_page(gid: str):
    return _page("results.html")


@app.get("/g/{gid}/edit")
def edit_page(gid: str):
    return _page("edit.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
