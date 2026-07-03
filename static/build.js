// ---- Pixel Reveal — game builder ----
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
let currentImg = null;      // HTMLImageElement of selected file
let currentFile = null;     // File object
const questions = [];       // {file, pixel, options[], correct, thumb, correctName}

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

// ---- pixelation preview (matches server: block-average downscale, nearest upscale) ----
function drawPixelated(canvas, img, blocks, maxW) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, maxW / w);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  canvas.width = dw; canvas.height = dh;
  const sw = Math.max(1, blocks);
  const sh = Math.max(1, Math.round(dh * sw / dw));
  const off = document.createElement("canvas");
  off.width = sw; off.height = sh;
  const octx = off.getContext("2d");
  octx.imageSmoothingEnabled = true;
  octx.drawImage(img, 0, 0, sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(off, 0, 0, sw, sh, 0, 0, dw, dh);
}

function refreshPreview() {
  if (!currentImg) return;
  const blocks = parseInt($("pix").value, 10);
  $("pixval").textContent = blocks + " blocks";
  drawPixelated($("preview"), currentImg, blocks, 760);
}

// ---- name pool UI ----
function refreshNameCount() {
  const n = namePool().length;
  $("namecount").textContent = n + (n === 1 ? " name" : " names");
}

function populateCorrectSelect() {
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

$("names").addEventListener("input", () => {
  refreshNameCount();
  if (currentImg) populateCorrectSelect();
});
$("nchoices").addEventListener("input", () => {
  $("nchoicesval").textContent = $("nchoices").value;
  updateDistractorNote();
});

// ---- file select ----
$("file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  currentFile = f;
  $("filelabel").textContent = f.name;
  const img = new Image();
  img.onload = () => {
    currentImg = img;
    $("pix").value = 22;
    $("composer").classList.remove("hidden");
    populateCorrectSelect();
    refreshPreview();
    $("composer").scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  img.src = URL.createObjectURL(f);
});

$("pix").addEventListener("input", refreshPreview);
$("cancel").addEventListener("click", resetComposer);

function resetComposer() {
  currentImg = null; currentFile = null;
  $("file").value = "";
  $("filelabel").textContent = "Choose an image…";
  $("composer").classList.add("hidden");
}

// ---- add question to the game ----
$("addq").addEventListener("click", () => {
  if (!currentImg || !currentFile) return;
  const pool = namePool();
  if (pool.length < 2) { toast("Add at least 2 names to the pool"); return; }
  const correctName = $("correctname").value;
  if (!correctName) { toast("Pick the correct name"); return; }

  const blocks = parseInt($("pix").value, 10);
  const { options, correct } = buildOptions(pool, correctName, nChoices());

  const thumbCanvas = document.createElement("canvas");
  drawPixelated(thumbCanvas, currentImg, blocks, 260);

  questions.push({
    file: currentFile,
    pixel: blocks,
    options,
    correct,
    correctName,
    thumb: thumbCanvas.toDataURL("image/png"),
  });
  renderQuestions();
  resetComposer();
  toast("Question added");
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
  $("publish").disabled = questions.length === 0;
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
      body: JSON.stringify({ title, names: namePool() }),
    });
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
  renderMyGames();
}

refreshNameCount();
renderMyGames();
initAuth();
