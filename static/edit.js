// ---- Pixelizer — question editor ----
const LOGO_COLORS = [
  "#1d2b1f", "#bfea4b", "#1d2b1f",
  "#bfea4b", "#c53a20", "#bfea4b",
  "#1d2b1f", "#bfea4b", "#1d2b1f",
];
const $ = (id) => document.getElementById(id);
const toast = (msg) => {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
};
const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
$("logo").innerHTML = LOGO_COLORS.map((c) => `<i style="background:${c}"></i>`).join("");

const GID = location.pathname.split("/")[2];
const MYGAMES_KEY = "pixelreveal:mygames";

// token from URL hash (#t=...) or from remembered games
function getToken() {
  const m = location.hash.match(/t=([a-f0-9]+)/i);
  if (m) return m[1];
  try {
    const games = JSON.parse(localStorage.getItem(MYGAMES_KEY)) || [];
    const g = games.find((x) => x.id === GID);
    return g ? g.token : null;
  } catch { return null; }
}
const TOKEN = getToken();
// query suffix for GET/DELETE; empty when relying on Google-account (session) auth
const tokenParam = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "";

function rememberGame(id, title, token) {
  let games = [];
  try { games = JSON.parse(localStorage.getItem(MYGAMES_KEY)) || []; } catch {}
  games = games.filter((g) => g.id !== id);
  games.unshift({ id, title, token, ts: Date.now() });
  localStorage.setItem(MYGAMES_KEY, JSON.stringify(games.slice(0, 50)));
}

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

function buildOptions(pool, correct, n) {
  const distractors = shuffle(pool.filter((x) => x !== correct)).slice(0, Math.max(1, n - 1));
  const options = shuffle([correct, ...distractors]);
  return { options, correct: options.indexOf(correct) };
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

// Drag a preview canvas to pan its square crop. `item` holds {img, cx, cy}
// (mutated in place); `redraw` repaints after each move.
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

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ---- shared options editor (manual per-question editing) ----
function makeOptsEditor(container, options, correctIndex, radioName) {
  container.innerHTML = "";
  let correct = correctIndex;

  function addRow(value = "") {
    const row = document.createElement("div");
    row.className = "opt-row";
    row.innerHTML = `
      <input type="radio" name="${radioName}" title="Mark correct">
      <input type="text" class="grow" placeholder="Answer" maxlength="120" value="${escapeHtml(value)}">
      <button class="mini" type="button" title="Remove">✕</button>`;
    row.querySelector("input[type=radio]").addEventListener("change", () => {
      correct = [...container.querySelectorAll(".opt-row")].indexOf(row);
    });
    row.querySelector(".mini").addEventListener("click", () => {
      if (container.querySelectorAll(".opt-row").length <= 2) { toast("Need at least 2 choices"); return; }
      row.remove();
      sync();
    });
    container.appendChild(row);
  }

  function sync() {
    container.querySelectorAll(".opt-row").forEach((row, i) => {
      row.querySelector("input[type=text]").placeholder = "Answer " + (i + 1);
      row.querySelector("input[type=radio]").checked = i === correct;
    });
  }

  (options.length ? options : ["", ""]).forEach((o) => addRow(o));
  correct = Math.min(correct, container.querySelectorAll(".opt-row").length - 1);
  sync();

  return {
    addRow: () => { addRow(); sync(); },
    getState() {
      const texts = [...container.querySelectorAll("input[type=text]")].map((i) => i.value.trim());
      const checked = [...container.querySelectorAll("input[type=radio]")].findIndex((r) => r.checked);
      const cur = Math.max(0, checked);
      const kept = []; let nc = 0;
      texts.forEach((t, i) => { if (t) { if (i === cur) nc = kept.length; kept.push(t); } });
      return { options: kept, correct: nc };
    },
  };
}

// ---- boot ----
let game = null;

(async function boot() {
  // no local token? still try — the server authorises signed-in Google owners too
  try {
    const r = await fetch(`/api/games/${GID}/admin${tokenParam}`);
    if (!r.ok) throw new Error();
    game = await r.json();
  } catch {
    $("gate").classList.remove("hidden");
    return;
  }
  if (TOKEN) rememberGame(GID, game.title, TOKEN);
  $("editor").classList.remove("hidden");
  $("title-h").textContent = game.title;
  $("gtitle").value = game.title;
  $("names").value = (game.names || []).join("\n");
  const modeRadio = document.querySelector(`input[name="answermode"][value="${game.answer_mode || "choices"}"]`);
  if (modeRadio) modeRadio.checked = true;
  refreshNameCount();
  $("playlink").href = `/g/${GID}`;
  $("statslink").href = `/g/${GID}/results`;
  renderAll();
})();

// ---- title save ----
$("savetitle").addEventListener("click", async () => {
  const title = $("gtitle").value.trim();
  if (!title) { toast("Title can't be empty"); return; }
  const r = await fetch(`/api/games/${GID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN || undefined, title }),
  });
  if (r.ok) {
    $("title-h").textContent = title;
    if (TOKEN) rememberGame(GID, title, TOKEN);
    toast("Title saved");
  }
  else toast("Couldn't save title");
});

// ---- name pool ----
function refreshNameCount() {
  const n = namePool().length;
  $("namecount").textContent = n + (n === 1 ? " name" : " names");
}
$("names").addEventListener("input", () => {
  refreshNameCount();
  if (addImg) populateAddSelect();
});
$("nchoices").addEventListener("input", () => {
  $("nchoicesval").textContent = $("nchoices").value;
  updateDistractorNote();
});
$("savenames").addEventListener("click", async () => {
  const r = await fetch(`/api/games/${GID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN || undefined, names: namePool(), answer_mode: answerMode() }),
  });
  if (r.ok) { game.names = namePool(); game.answer_mode = answerMode(); toast("Settings saved"); }
  else toast("Couldn't save settings");
});

$("copyshare").addEventListener("click", async () => {
  const url = `${location.origin}/g/${GID}`;
  try { await navigator.clipboard.writeText(url); toast("Share link copied"); }
  catch { toast(url); }
});

// ---- render all question cards ----
async function renderAll() {
  const box = $("qcontainer");
  box.innerHTML = "";
  $("qcount").textContent = `${game.questions.length} question${game.questions.length === 1 ? "" : "s"}`;
  for (let i = 0; i < game.questions.length; i++) {
    box.appendChild(await buildCard(game.questions[i], i));
  }
}

async function buildCard(q, index) {
  const card = document.createElement("div");
  card.className = "qedit";
  card.dataset.qid = q.id;
  card.innerHTML = `
    <div class="qedit-head">
      <span class="idxpill">Image ${index + 1}</span>
      <div class="reorder">
        <button type="button" data-act="up" title="Move up">↑</button>
        <button type="button" data-act="down" title="Move down">↓</button>
      </div>
    </div>
    <div class="qedit-top">
      <div>
        <canvas class="preview"></canvas>
        <div class="radio-hint" style="margin-top:6px;">Drag the image to reposition its crop.</div>
        <label class="filebtn" style="margin-top:8px;">
          <span class="replacelabel">Replace image…</span>
          <input type="file" accept="image/*" class="replace">
        </label>
      </div>
      <div class="qedit-body">
        <label>Resolution <span class="muted">— lower = harder</span></label>
        <div class="sliderrow">
          <input type="range" class="pix" min="4" max="120" value="${q.pixel_size}">
          <span class="val pixval">${q.pixel_size} blocks</span>
        </div>
        <hr class="sep">
        <label>Answer choices <span class="muted">— select the correct one</span></label>
        <div class="opts"></div>
        <div class="row" style="gap:8px; margin-top:4px;">
          <button class="btn-ghost addopt" type="button">+ Add choice</button>
          <button class="btn-ghost reroll" type="button">🎲 Re-roll wrong answers</button>
        </div>
        <hr class="sep">
        <div class="row spread">
          <button class="mini delq" type="button">Delete question</button>
          <span class="row" style="gap:10px;">
            <span class="savedflag hidden">Saved ✓</span>
            <button class="btn-primary saveq" type="button">Save changes</button>
          </span>
        </div>
      </div>
    </div>`;

  const canvas = card.querySelector(".preview");
  const pix = card.querySelector(".pix");
  const pixval = card.querySelector(".pixval");
  const optsBox = card.querySelector(".opts");
  const savedFlag = card.querySelector(".savedflag");
  let editor = makeOptsEditor(optsBox, q.options, q.correct_index, "correct-" + q.id);

  // load the uncropped original so the crop can be re-panned against full framing
  let baseImg = await loadImage(`/api/questions/${q.id}/source.png${tokenParam}${tokenParam ? "&" : "?"}v=${Date.now()}`);
  let pendingFile = null;
  const crop = { img: baseImg, cx: q.crop_x ?? 0.5, cy: q.crop_y ?? 0.5 };

  const refresh = () => {
    pixval.textContent = pix.value + " blocks";
    drawPixelated(canvas, crop.img, parseInt(pix.value, 10), 320, crop.cx, crop.cy);
  };
  refresh();

  const dirty = () => savedFlag.classList.add("hidden");
  attachCropDrag(canvas, crop, () => { refresh(); dirty(); });
  pix.addEventListener("input", () => { refresh(); dirty(); });
  card.querySelector(".addopt").addEventListener("click", () => { editor.addRow(); dirty(); });
  optsBox.addEventListener("input", dirty);
  optsBox.addEventListener("change", dirty);

  // re-roll: keep the correct answer, resample distractors from the pool
  card.querySelector(".reroll").addEventListener("click", () => {
    const pool = namePool();
    if (pool.length < 2) { toast("Add names to the pool first"); return; }
    const st = editor.getState();
    const correctName = st.options[st.correct];
    if (!correctName) { toast("Set the correct answer first"); return; }
    if (!pool.includes(correctName)) { toast(`"${correctName}" isn't in the pool`); return; }
    const rolled = buildOptions(pool, correctName, st.options.length || nChoices());
    editor = makeOptsEditor(optsBox, rolled.options, rolled.correct, "correct-" + q.id);
    dirty();
    toast("Wrong answers re-rolled");
  });

  card.querySelector(".replace").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    pendingFile = f;
    card.querySelector(".replacelabel").textContent = f.name;
    baseImg = await loadImage(URL.createObjectURL(f));
    crop.img = baseImg; crop.cx = 0.5; crop.cy = 0.5;  // new image → recentre crop
    refresh();
    dirty();
  });

  card.querySelector(".saveq").addEventListener("click", async () => {
    const st = editor.getState();
    if (st.options.length < 2) { toast("Need at least 2 non-empty choices"); return; }
    const btn = card.querySelector(".saveq");
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const fd = new FormData();
      if (TOKEN) fd.append("token", TOKEN);
      fd.append("pixel_size", pix.value);
      fd.append("options", JSON.stringify(st.options));
      fd.append("correct_index", String(st.correct));
      fd.append("crop_x", String(crop.cx));
      fd.append("crop_y", String(crop.cy));
      if (pendingFile) fd.append("image", pendingFile);
      const r = await fetch(`/api/questions/${q.id}`, { method: "PATCH", body: fd });
      if (!r.ok) throw new Error();
      pendingFile = null;
      card.querySelector(".replacelabel").textContent = "Replace image…";
      editor = makeOptsEditor(optsBox, st.options, st.correct, "correct-" + q.id);
      savedFlag.classList.remove("hidden");
      toast("Saved");
    } catch { toast("Couldn't save"); }
    btn.disabled = false; btn.textContent = "Save changes";
  });

  card.querySelector(".delq").addEventListener("click", async () => {
    if (!confirm("Delete this question? This can't be undone.")) return;
    const r = await fetch(`/api/questions/${q.id}${tokenParam}`, { method: "DELETE" });
    if (r.ok) {
      game.questions = game.questions.filter((x) => x.id !== q.id);
      renderAll();
      toast("Question deleted");
    } else toast("Couldn't delete");
  });

  card.querySelector('[data-act="up"]').addEventListener("click", () => move(q.id, -1));
  card.querySelector('[data-act="down"]').addEventListener("click", () => move(q.id, +1));

  return card;
}

async function move(qid, delta) {
  const i = game.questions.findIndex((x) => x.id === qid);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= game.questions.length) return;
  [game.questions[i], game.questions[j]] = [game.questions[j], game.questions[i]];
  await renderAll();
  const order = game.questions.map((x) => x.id);
  await fetch(`/api/games/${GID}/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: TOKEN || undefined, order }),
  });
}

// ---- add-another composer (pool-based) ----
let addImg = null, addFile = null;

function populateAddSelect() {
  const pool = namePool();
  const sel = $("correctname");
  const prev = sel.value;
  sel.innerHTML = pool.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  if (pool.includes(prev)) sel.value = prev;
  sel.disabled = pool.length < 2;
  updateDistractorNote();
}

function updateDistractorNote() {
  const pool = namePool();
  const note = $("distractornote");
  const addBtn = $("addq");
  if (pool.length < 2) {
    note.innerHTML = `Add at least <b>2 names</b> to the pool above first.`;
    addBtn.disabled = true;
    return;
  }
  const shown = Math.min(nChoices(), pool.length);
  note.innerHTML = `Shows <b>${shown}</b> choices — the correct name plus <b>${shown - 1}</b> random name${shown - 1 === 1 ? "" : "s"} from your pool.`;
  addBtn.disabled = false;
}

$("file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  addFile = f;
  $("filelabel").textContent = f.name;
  const img = new Image();
  img.onload = () => {
    addImg = img;
    $("pix").value = 22;
    $("composer").classList.remove("hidden");
    populateAddSelect();
    drawAddPreview();
  };
  img.src = URL.createObjectURL(f);
});

function drawAddPreview() {
  if (!addImg) return;
  $("pixval").textContent = $("pix").value + " blocks";
  drawPixelated($("preview"), addImg, parseInt($("pix").value, 10), 760);
}
$("pix").addEventListener("input", drawAddPreview);
$("cancel").addEventListener("click", resetAdd);

function resetAdd() {
  addImg = null; addFile = null;
  $("file").value = "";
  $("filelabel").textContent = "Choose an image…";
  $("composer").classList.add("hidden");
}

$("addq").addEventListener("click", async () => {
  if (!addFile) return;
  const pool = namePool();
  if (pool.length < 2) { toast("Add at least 2 names to the pool"); return; }
  const correctName = $("correctname").value;
  if (!correctName) { toast("Pick the correct name"); return; }
  const { options, correct } = buildOptions(pool, correctName, nChoices());
  const btn = $("addq");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const fd = new FormData();
    fd.append("image", addFile);
    fd.append("pixel_size", $("pix").value);
    fd.append("options", JSON.stringify(options));
    fd.append("correct_index", String(correct));
    if (TOKEN) fd.append("token", TOKEN);
    const r = await fetch(`/api/games/${GID}/questions`, { method: "POST", body: fd });
    if (!r.ok) throw new Error();
    const ar = await fetch(`/api/games/${GID}/admin${tokenParam}`);
    game = await ar.json();
    resetAdd();
    await renderAll();
    toast("Question added");
  } catch { toast("Couldn't add question"); }
  btn.disabled = false; btn.textContent = "Add to game →";
});
