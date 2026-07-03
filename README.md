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

Google sign-in is **optional** — the app runs fine without it (games are then anonymous,
managed per-device). To turn it on, see [Accounts & Google sign-in](#accounts--google-sign-in).

## How it works

- **Browse** (`/browse`) — a public directory of every published game (newest first),
  each card showing a pixelated cover, image count, and play count. No sign-in needed.
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

## Accounts & Google sign-in

Sign-in is optional and additive:

- **Signed out** — everything works as before. Creating a game returns a secret
  `edit_token` kept in `localStorage`; that token is what authorises edits.
- **Signed in with Google** — new games you create are also tagged with your account, so
  **Your games** syncs across every device you log in on, and you can edit them without the
  token. Ownership is checked by *either* the edit token *or* your account, so old links
  keep working.

Auth uses OpenID Connect (Authlib) with a signed session cookie. No password is stored — only
your Google `sub` id, name, email, and avatar URL, kept in the session.

### Enabling it (Google Cloud setup)

1. **Create a project** at <https://console.cloud.google.com> (or reuse one).
2. **OAuth consent screen** → *External* → fill app name, support email, developer contact.
   Scopes: the defaults (`openid`, `email`, `profile`) are enough — add nothing sensitive.
   While the app is in *Testing*, add your Google account under **Test users**.
3. **Credentials** → **Create credentials** → **OAuth client ID** → *Web application*.
   Under **Authorized redirect URIs** add the callback for every origin you'll open the app on:
   - `http://localhost:8777/auth/callback`
   - `http://127.0.0.1:8777/auth/callback`
   - `http://<your-LAN-IP>:8777/auth/callback` (only if others sign in over the LAN)
4. Copy the **Client ID** and **Client secret**.
5. `cp .env.example .env` and fill it in:
   ```bash
   SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))")
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```
6. Restart `./run.sh`. A **Sign in with Google** button appears in the top bar.

> The callback URL is derived from the host you visit, so **sign in from an origin whose
> redirect URI you registered** (e.g. `http://localhost:8777`). Visiting via an unregistered
> host/port gives Google's `redirect_uri_mismatch` error — just add that URI in step 3.

`.env` is git-ignored; never commit your client secret.

## Sharing on a LAN

The server binds `0.0.0.0`, so others on your network can play. Open the **builder
from your machine's LAN IP** (e.g. `http://192.168.1.20:8777`) so the generated
share links point at that IP instead of `127.0.0.1`.

## Layout

```
app/main.py        FastAPI app — API, auth, pixelation, pages
static/            index/browse/play/results/edit HTML + JS, shared style.css, favicon
data/              sqlite db + uploaded/cached images (git-ignored)
.env               SECRET_KEY + Google OAuth creds (git-ignored; optional)
```

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/browse` | public directory of published games (cover, counts, creator) |
| GET  | `/api/me` | `{enabled, user}` — is Google login configured, and who's signed in |
| GET  | `/api/mygames` | games owned by the signed-in account (empty when signed out) |
| GET  | `/auth/login` · `/auth/callback` · `/auth/logout` | Google OAuth flow |
| POST | `/api/games` | create a game (`{title}`) → returns `edit_token`; tagged to account if signed in |
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
