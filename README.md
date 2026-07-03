---
tags:
  - project
  - game
  - fastapi
  - webapp
---

# Pixel Reveal

A pixelated-image multiple-choice guessing game. Build a game by uploading images,
set how pixelated each one starts, write the answer choices — then share a link.
Players guess, the image reveals crisp, and their score lands on a leaderboard.
Guess distributions are tracked per question.

## Run

```bash
./run.sh
# first run creates a venv + installs deps, then serves on http://127.0.0.1:8777
```

Override the port with `PORT=9000 ./run.sh`.

## How it works

- **Builder** (`/`) — enter your **name pool** once and pick a "choices per image"
  count. For each image, drag the resolution slider (lower = harder) and just pick
  **who it is**; the wrong answers are drawn at random from the pool and baked into
  that question. Add, repeat, then **Publish** for a share link.
- **Play** (`/g/{code}`) — each image starts pixelated; pick a guess, it reveals
  the crisp photo and marks right/wrong. Enter a name at the end to join the board.
- **Stats** (`/g/{code}/results`) — leaderboard plus a per-question breakdown of
  what everyone guessed.
- **Edit** (`/g/{code}/edit`) — change the title, name pool, options, correct
  answer, and pixelation of any question; **🎲 re-roll** a question's wrong answers
  from the pool; replace an image; reorder; delete; add more. Games you create are
  listed under **Your games** on the home page, each with an Edit link. Editing
  requires the game's secret **edit token**.

The name pool is stored per game so the editor can reuse it for adding images and
re-rolling. Options are still **baked per question** (a fixed list), so guess-stats
aggregate correctly — re-rolling or editing changes only that question going forward.

## Design notes

- **Pixelation is server-side** (Pillow): players only ever receive the pixelated
  PNG. The crisp image and correct answer are served only after a guess is made,
  so answers aren't sitting in the initial game payload.
- **Scoring is server-side** — the client can't fake a score.
- **Play-once** is enforced with `localStorage` per game code (`pixelreveal:played:{code}`).
- **Editing is token-gated**: creating a game returns a secret `edit_token`, stored
  in `localStorage` (`pixelreveal:mygames`). All mutating endpoints require it, so
  players who only have the share link can't change your questions or answers.
- SQLite (`data/games.db`), uploads in `data/uploads/`, pixelated/crisp cache in
  `data/cache/` — all git-ignored.

## Sharing on a LAN

The server binds `0.0.0.0`, so others on your network can play. Open the **builder
from your machine's LAN IP** (e.g. `http://192.168.1.20:8777`) so the generated
share links point at that IP instead of `127.0.0.1`.

## Layout

```
app/main.py        FastAPI app — API, pixelation, pages
static/            index/play/results/edit HTML + JS, shared style.css, favicon
data/              sqlite db + uploaded/cached images (git-ignored)
```

## API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/games` | create a game (`{title}`) → returns `edit_token` |
| POST | `/api/games/{id}/questions` | add a question (multipart: image, pixel_size, options, correct_index, **token**) |
| GET  | `/api/games/{id}` | public game payload (no answers) |
| GET  | `/api/games/{id}/admin?token=` | owner payload (includes answers + pixel sizes) |
| PATCH | `/api/games/{id}` | rename game (`{token, title}`) |
| PATCH | `/api/questions/{id}` | edit a question (multipart: token, pixel_size, options, correct_index, optional image) |
| DELETE | `/api/questions/{id}?token=` | delete a question |
| POST | `/api/games/{id}/reorder` | reorder (`{token, order:[qid,…]}`) |
| GET  | `/api/questions/{id}/pixel.png` | pixelated image |
| GET  | `/api/questions/{id}/crisp.png` | crisp image (reveal) |
| GET  | `/api/questions/{id}/answer` | correct option index (post-guess reveal) |
| POST | `/api/games/{id}/plays` | submit a play, get score + leaderboard |
| GET  | `/api/games/{id}/stats` | leaderboard + guess distribution |
