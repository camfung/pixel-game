// ---- Pixelizer — game builder ----
const LOGO_COLORS = [
  "#1d2b1f", "#bfea4b", "#1d2b1f",
  "#bfea4b", "#c53a20", "#bfea4b",
  "#1d2b1f", "#bfea4b", "#1d2b1f",
];

const $ = (id) => document.getElementById(id);
const toast = (msg) => {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
};
const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

$("logo").innerHTML = LOGO_COLORS.map((c) => `<i style="background:${c}"></i>`).join("");

// ---- state ----
const questions = [];       // {file, pixel, options[], correct, thumb, correctName}
const staged = [];          // images picked but not yet added: {file, img, name}

// ---- name pool helpers ----
function parseNames(text) {
  const out = [], seen = new Set();
  text.split(/[\n,]/).forEach((raw) => {
    const s = raw.trim();
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  });
  return out;
}
const namePool = () => parseNames($("names").value);
const nChoices = () => parseInt($("nchoices").value, 10);
const answerMode = () =>
  (document.querySelector('input[name="answermode"]:checked') || {}).value || "choices";

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// bake fixed options: correct + random distractors from the pool, shuffled
function buildOptions(pool, correct, n) {
  const distractors = shuffle(pool.filter((x) => x !== correct)).slice(0, Math.max(1, n - 1));
  const options = shuffle([correct, ...distractors]);
  return { options, correct: options.indexOf(correct) };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// guess the correct name from the filename ("Omar (1).jpg" -> "Omar") against the pool
function guessNameFromFile(filename, pool) {
  const base = filename.replace(/\.[^.]+$/, "").trim().toLowerCase();
  let hit = pool.find((n) => n.toLowerCase() === base);
  if (hit) return hit;
  const tokens = base.split(/[^a-z0-9]+/i).filter(Boolean);
  return pool.find((n) => tokens.includes(n.toLowerCase())) || "";
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---- pixelation preview (matches server: square crop around focal point
// (cx,cy), block-average downscale, nearest upscale) ----
function drawPixelated(canvas, img, blocks, maxSize, cx = 0.5, cy = 0.5) {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const s = Math.min(iw, ih);              // square crop side in source pixels
  const sx = clamp01(cx) * (iw - s), sy = clamp01(cy) * (ih - s);  // focal offset
  const size = Math.max(1, Math.min(maxSize, s));  // output square side
  canvas.width = size; canvas.height = size;
  const blk = Math.max(1, blocks);         // square, so same block count both axes
  const off = document.createElement("canvas");
  off.width = blk; off.height = blk;
  const octx = off.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.drawImage(img, sx, sy, s, s, 0, 0, blk, blk);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(off, 0, 0, blk, blk, 0, 0, size, size);
}

// Let the user drag a preview canvas to pan the square crop. `item` holds the
// image plus its current cx/cy (mutated in place); `redraw` repaints after each move.
function attachCropDrag(canvas, item, redraw) {
  canvas.classList.add("croppable");
  let sx0, sy0, cx0, cy0, rect;
  const onMove = (e) => {
    const iw = item.img.naturalWidth, ih = item.img.naturalHeight;
    const s = Math.min(iw, ih);
    const dx = e.clientX - sx0, dy = e.clientY - sy0;
    if (iw > s) item.cx = clamp01(cx0 - (dx / rect.width) * s / (iw - s));
    if (ih > s) item.cy = clamp01(cy0 - (dy / rect.height) * s / (ih - s));
    redraw();
  };
  const onUp = (e) => {
    canvas.classList.remove("grabbing");
    canvas.removeEventListener("pointermove", onMove);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    rect = canvas.getBoundingClientRect();
    sx0 = e.clientX; sy0 = e.clientY; cx0 = item.cx; cy0 = item.cy;
    canvas.classList.add("grabbing");
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    canvas.addEventListener("pointermove", onMove);
  });
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
}

// ---- name pool UI ----
function refreshNameCount() {
  const n = namePool().length;
  $("namecount").textContent = n + (n === 1 ? " name" : " names");
}

// ---- bulk staging ----
$("file").addEventListener("change", async (e) => {
  const files = [...e.target.files].filter((f) => f.type.startsWith("image/"));
  e.target.value = "";  // let the user re-pick / add more later
  if (!files.length) return;
  const pool = namePool();
  for (const f of files) {
    try {
      const img = await loadImage(URL.createObjectURL(f));
      staged.push({ file: f, img, name: guessNameFromFile(f.name, pool), cx: 0.5, cy: 0.5 });
    } catch { toast(`Couldn't read ${f.name}`); }
  }
  $("composer").classList.remove("hidden");
  renderStaged();
  $("composer").scrollIntoView({ behavior: "smooth", block: "nearest" });
});

$("pix").addEventListener("input", () => {
  $("pixval").textContent = $("pix").value + " blocks";
  redrawStagedThumbs();
});
$("nchoices").addEventListener("input", () => {
  $("nchoicesval").textContent = $("nchoices").value;
  refreshStageNote();
});
$("names").addEventListener("input", () => {
  refreshNameCount();
  if (staged.length) renderStaged();  // re-match filenames + refresh name dropdowns
});
$("cancel").addEventListener("click", resetComposer);

function resetComposer() {
  staged.length = 0;
  $("file").value = "";
  $("filelabel").textContent = "Choose image(s)…";
  $("composer").classList.add("hidden");
}

function refreshStageNote() {
  const pool = namePool();
  const note = $("distractornote");
  if (pool.length < 2) {
    note.innerHTML = `Add at least <b>2 names</b> to the pool above first.`;
    return;
  }
  const shown = Math.min(nChoices(), pool.length);
  note.innerHTML = `Each image shows <b>${shown}</b> choices — the correct name plus <b>${shown - 1}</b> random name${shown - 1 === 1 ? "" : "s"} from your pool.`;
}

function redrawStagedThumbs() {
  const blocks = parseInt($("pix").value, 10);
  document.querySelectorAll("#stagedlist canvas").forEach((canvas, i) => {
    if (staged[i]) drawPixelated(canvas, staged[i].img, blocks, 260, staged[i].cx, staged[i].cy);
  });
}

function renderStaged() {
  const pool = namePool();
  const blocks = parseInt($("pix").value, 10);
  const list = $("stagedlist");
  list.innerHTML = "";
  staged.forEach((s, i) => {
    if (s.name && !pool.includes(s.name)) s.name = "";  // pool changed under it
    if (!s.name) s.name = guessNameFromFile(s.file.name, pool);
    const card = document.createElement("div");
    card.className = "stagecard" + (s.name ? "" : " needsname");
    card.innerHTML = `
      <button class="x" title="Remove" type="button">✕</button>
      <canvas></canvas>
      <div class="stagebody">
        <div class="fname" title="${escapeHtml(s.file.name)}">${escapeHtml(s.file.name)}</div>
        <select>
          <option value="">— pick name —</option>
          ${pool.map((n) => `<option value="${escapeHtml(n)}"${n === s.name ? " selected" : ""}>${escapeHtml(n)}</option>`).join("")}
        </select>
      </div>`;
    const canvas = card.querySelector("canvas");
    drawPixelated(canvas, s.img, blocks, 260, s.cx, s.cy);
    attachCropDrag(canvas, s, () =>
      drawPixelated(canvas, s.img, parseInt($("pix").value, 10), 260, s.cx, s.cy));
    const sel = card.querySelector("select");
    sel.disabled = pool.length < 2;
    sel.addEventListener("change", () => {
      s.name = sel.value;
      card.classList.toggle("needsname", !s.name);
    });
    card.querySelector(".x").addEventListener("click", () => {
      staged.splice(i, 1);
      if (staged.length) renderStaged(); else resetComposer();
    });
    list.appendChild(card);
  });
  $("stagecount").textContent = staged.length + (staged.length === 1 ? " image" : " images");
  refreshStageNote();
}

// ---- add all staged images to the game ----
$("addall").addEventListener("click", () => {
  if (!staged.length) return;
  const pool = namePool();
  if (pool.length < 2) { toast("Add at least 2 names to the pool"); return; }
  const missing = staged.filter((s) => !s.name).length;
  if (missing) { toast(`Pick a name for ${missing} more image${missing === 1 ? "" : "s"}`); return; }

  const blocks = parseInt($("pix").value, 10);
  staged.forEach((s) => {
    const { options, correct } = buildOptions(pool, s.name, nChoices());
    const thumbCanvas = document.createElement("canvas");
    drawPixelated(thumbCanvas, s.img, blocks, 260, s.cx, s.cy);
    questions.push({
      file: s.file,
      pixel: blocks,
      options,
      correct,
      correctName: s.name,
      cx: s.cx,
      cy: s.cy,
      thumb: thumbCanvas.toDataURL("image/png"),
    });
  });
  const n = staged.length;
  renderQuestions();
  resetComposer();
  toast(`Added ${n} image${n === 1 ? "" : "s"}`);
});

function renderQuestions() {
  const list = $("qlist");
  list.innerHTML = "";
  questions.forEach((q, i) => {
    const el = document.createElement("div");
    el.className = "qthumb";
    el.innerHTML = `
      <button class="x" title="Remove" data-i="${i}">✕</button>
      <img src="${q.thumb}" alt="">
      <div class="lbl"><b>${escapeHtml(q.correctName)}</b><br>${q.options.length} choices · ${q.pixel}px</div>`;
    el.querySelector(".x").addEventListener("click", () => {
      questions.splice(i, 1);
      renderQuestions();
    });
    list.appendChild(el);
  });
  $("qcount").textContent = questions.length + " added";
  $("qempty").classList.toggle("hidden", questions.length > 0);
  updatePublishState();
}

// Publishing needs at least one question AND (when accounts are enabled) a
// signed-in user. `canPublish` starts true so local/no-auth setups still work.
let canPublish = true;
function updatePublishState() {
  $("publish").disabled = questions.length === 0 || !canPublish;
}

// ---- publish ----
$("publish").addEventListener("click", async () => {
  if (questions.length === 0) return;
  const btn = $("publish");
  btn.disabled = true;
  btn.textContent = "Publishing…";
  try {
    const title = $("title").value.trim() || "Untitled game";
    const gres = await fetch("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, names: namePool(), answer_mode: answerMode() }),
    });
    if (gres.status === 401) {
      canPublish = false;
      $("signingate").classList.remove("hidden");
      updatePublishState();
      $("signingate").scrollIntoView({ behavior: "smooth", block: "center" });
      throw new Error("Sign in to publish your game");
    }
    if (!gres.ok) throw new Error("create game failed");
    const { id, edit_token } = await gres.json();

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      btn.textContent = `Uploading ${i + 1}/${questions.length}…`;
      const fd = new FormData();
      fd.append("image", q.file);
      fd.append("pixel_size", String(q.pixel));
      fd.append("options", JSON.stringify(q.options));
      fd.append("correct_index", String(q.correct));
      fd.append("crop_x", String(q.cx ?? 0.5));
      fd.append("crop_y", String(q.cy ?? 0.5));
      fd.append("token", edit_token);
      const r = await fetch(`/api/games/${id}/questions`, { method: "POST", body: fd });
      if (!r.ok) throw new Error("upload failed at #" + (i + 1));
    }

    rememberGame(id, title, edit_token);

    const url = `${location.origin}/g/${id}`;
    $("sharelink").value = url;
    $("playnow").href = url;
    $("viewstats").href = `${url}/results`;
    $("editgame").href = `${url}/edit#t=${edit_token}`;
    $("publishout").classList.remove("hidden");
    btn.textContent = "Published ✓";
    $("publishout").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    toast("Error: " + err.message);
    btn.disabled = false;
    btn.textContent = "Publish game";
  }
});

$("copy").addEventListener("click", async () => {
  const url = $("sharelink").value;
  try { await navigator.clipboard.writeText(url); toast("Link copied"); }
  catch { $("sharelink").select(); document.execCommand("copy"); toast("Link copied"); }
});

$("how").addEventListener("click", (e) => {
  e.preventDefault();
  toast("Add names → upload → pick who it is → publish → share!");
});

// ---- "my games" — localStorage (device) merged with account games (server) ----
const MYGAMES_KEY = "pixelreveal:mygames";
let accountGames = [];  // games owned by the signed-in Google account

function loadMyGames() {
  try { return JSON.parse(localStorage.getItem(MYGAMES_KEY)) || []; }
  catch { return []; }
}

function rememberGame(id, title, token) {
  const games = loadMyGames().filter((g) => g.id !== id);
  games.unshift({ id, title, token, ts: Date.now() });
  localStorage.setItem(MYGAMES_KEY, JSON.stringify(games.slice(0, 50)));
  renderMyGames();
}

function renderMyGames() {
  const seen = new Set();
  const merged = accountGames.map((g) => {
    seen.add(g.id);
    return { id: g.id, title: g.title, token: g.edit_token };
  });
  loadMyGames().forEach((g) => { if (!seen.has(g.id)) merged.push(g); });

  const card = $("mygames");
  if (merged.length === 0) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  if (accountGames.length) $("mygamespill").textContent = "synced to your account";
  $("mygameslist").innerHTML = merged
    .map((g) => {
      const edit = g.token ? `/g/${g.id}/edit#t=${g.token}` : `/g/${g.id}/edit`;
      return `<div class="mygame">
      <span class="grow" title="${escapeHtml(g.title)}">${escapeHtml(g.title)}</span>
      <a class="arrow-link" href="${edit}">Edit</a>
      <a href="/g/${g.id}">Play</a>
      <a href="/g/${g.id}/results">Stats</a>
    </div>`;
    })
    .join("");
}

// ---- top-right auth chip + load account-owned games ----
async function initAuth() {
  let me = { enabled: false, user: null };
  try { me = await fetch("/api/me").then((r) => r.json()); } catch {}
  const box = $("authbox");
  if (me.user) {
    const pic = me.user.picture
      ? `<img class="avatar" src="${escapeHtml(me.user.picture)}" alt="" referrerpolicy="no-referrer">` : "";
    box.innerHTML =
      `<span class="userchip">${pic}${escapeHtml(me.user.name)}</span>` +
      `<a class="arrow-link" href="/auth/logout">Sign out</a>`;
    try { accountGames = (await fetch("/api/mygames").then((r) => r.json())).games || []; } catch {}
  } else if (me.enabled) {
    box.innerHTML = `<a class="btn btn-ghost gbtn" href="/auth/login?next=%2F">Sign in with Google</a>`;
  }
  // Gate publishing on being signed in whenever accounts are enabled.
  canPublish = !(me.enabled && !me.user);
  $("signingate").classList.toggle("hidden", canPublish);
  updatePublishState();
  renderMyGames();
}

refreshNameCount();
renderMyGames();
initAuth();
