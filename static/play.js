// ---- Pixelizer — player ----
const LOGO_COLORS = [
  "#1d2b1f", "#bfea4b", "#1d2b1f",
  "#bfea4b", "#c53a20", "#bfea4b",
  "#1d2b1f", "#bfea4b", "#1d2b1f",
];
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");
const toast = (msg) => {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
};
$("logo").innerHTML = LOGO_COLORS.map((c) => `<i style="background:${c}"></i>`).join("");

const GID = location.pathname.split("/")[2];
const PLAYED_KEY = "pixelreveal:played:" + GID;

function clientId() {
  let id = localStorage.getItem("pixelreveal:client");
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
    localStorage.setItem("pixelreveal:client", id);
  }
  return id;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

let game = null;
let idx = 0;
let localScore = 0;
const myAnswers = [];   // {question_id, chosen_index}
let locked = false;     // one guess per question

// ---- boot ----
(async function boot() {
  try {
    const res = await fetch(`/api/games/${GID}`);
    if (!res.ok) throw new Error("Game not found");
    game = await res.json();
  } catch (e) {
    document.querySelector(".wrap").innerHTML =
      `<div class="banner err">Couldn't load this game — the link may be wrong.</div><a class="arrow-link" href="/">Build a game</a>`;
    return;
  }

  $("gametitle").textContent = game.title;
  $("introtitle").textContent = game.title;
  $("qn").textContent = `${game.questions.length} image${game.questions.length === 1 ? "" : "s"} to guess.`;

  const prev = localStorage.getItem(PLAYED_KEY);
  if (prev) {
    showAlreadyPlayed(JSON.parse(prev));
  } else {
    show("intro");
  }
})();

$("start").addEventListener("click", () => {
  hide("intro");
  show("game");
  renderProgress();
  loadQuestion();
});

function renderProgress() {
  $("progress").innerHTML = game.questions
    .map((_, i) => `<span class="dot ${i < idx ? "done" : i === idx ? "cur" : ""}"></span>`)
    .join("");
}

const selectMode = () => game.answer_mode === "select";

let crispPreload = null;  // holds the in-flight preload so it isn't GC'd

function loadQuestion() {
  locked = false;
  const q = game.questions[idx];
  const shot = $("shot");
  shot.classList.remove("crisp");
  shot.src = `/api/questions/${q.id}/pixel.png`;
  hide("next");

  // Warm the crisp image now, while the player is guessing, so revealing it
  // after they answer is instant (served from cache — endpoint sets max-age).
  crispPreload = new Image();
  crispPreload.src = `/api/questions/${q.id}/crisp.png`;

  const box = $("choices");
  box.innerHTML = "";
  box.classList.toggle("as-select", selectMode());
  if (selectMode()) {
    $("hint").textContent = "Pick from the list, then guess";
    // Dropdown lists the entire name pool (falling back to this question's
    // options for older games that predate the pool being sent), sorted A–Z.
    const names = (game.names && game.names.length ? game.names : q.options)
      .slice().sort((a, b) => a.localeCompare(b));
    const sel = document.createElement("select");
    sel.className = "guess-select";
    sel.innerHTML =
      `<option value="" disabled selected>Choose an answer…</option>` +
      names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
    const go = document.createElement("button");
    go.className = "btn-primary guess-go";
    go.textContent = "Guess";
    go.disabled = true;
    sel.addEventListener("change", () => { go.disabled = sel.value === ""; });
    go.addEventListener("click", () => {
      if (sel.value !== "") pickSelect(sel.value, sel, go);
    });
    box.appendChild(sel);
    box.appendChild(go);
  } else {
    $("hint").textContent = "Tap your guess";
    q.options.forEach((opt, i) => {
      const b = document.createElement("button");
      b.className = "choice";
      b.textContent = opt;
      b.addEventListener("click", () => pick(i, b));
      box.appendChild(b);
    });
  }
  renderProgress();
}

// fetch the correct answer only once a guess is committed
async function fetchCorrect(q) {
  try {
    const r = await fetch(`/api/questions/${q.id}/answer`);
    return (await r.json()).correct_index;
  } catch (_) { return -1; }
}

function finishGuess(q) {
  const shot = $("shot");
  shot.classList.add("crisp");
  shot.src = `/api/questions/${q.id}/crisp.png`;
  $("next").textContent = idx + 1 < game.questions.length ? "Next →" : "Finish →";
  show("next");
}

async function pick(choiceIdx, btn) {
  if (locked) return;
  locked = true;
  const q = game.questions[idx];
  myAnswers.push({ question_id: q.id, chosen_index: choiceIdx });

  const correct = await fetchCorrect(q);
  const buttons = [...$("choices").children];
  buttons.forEach((b) => (b.disabled = true));
  if (choiceIdx === correct) {
    btn.classList.add("correct");
    localScore++;
    $("hint").textContent = "Correct!";
  } else {
    btn.classList.add("wrong");
    if (buttons[correct]) buttons[correct].classList.add("correct");
    $("hint").textContent = "Not quite — here's the real one.";
  }
  finishGuess(q);
}

async function pickSelect(name, sel, go) {
  if (locked) return;
  locked = true;
  const q = game.questions[idx];
  // Map the chosen name back to its index in this question's options so scoring
  // stays index-based. Any pool name that isn't an option here is a wrong guess.
  const choiceIdx = q.options.indexOf(name);
  myAnswers.push({ question_id: q.id, chosen_index: choiceIdx });

  const correct = await fetchCorrect(q);
  sel.disabled = true;
  go.disabled = true;
  if (choiceIdx === correct) {
    localScore++;
    $("hint").textContent = "Correct!";
  } else {
    const answer = q.options[correct] != null ? q.options[correct] : "";
    $("hint").textContent = `Not quite — it's ${answer}.`;
  }
  finishGuess(q);
}

$("next").addEventListener("click", () => {
  idx++;
  if (idx < game.questions.length) {
    loadQuestion();
  } else {
    hide("game");
    // Lock the game as played the moment it's finished, before the name is
    // submitted — a refresh here shouldn't let the player replay. Overwritten
    // with the server-confirmed score + name once they submit.
    localStorage.setItem(PLAYED_KEY, JSON.stringify({ name: null, score: localScore, total: game.questions.length }));
    $("rawscore").innerHTML = `${localScore}<span> / ${game.questions.length}</span>`;
    show("finish");
  }
});

$("submit").addEventListener("click", async () => {
  const name = $("name").value.trim() || "Anonymous";
  const btn = $("submit");
  btn.disabled = true; btn.textContent = "Submitting…";
  try {
    const res = await fetch(`/api/games/${GID}/plays`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, client_id: clientId(), answers: myAnswers }),
    });
    if (!res.ok) throw new Error("submit failed");
    const data = await res.json();
    localStorage.setItem(PLAYED_KEY, JSON.stringify({ name, score: data.score, total: data.total }));
    hide("finish");
    $("donelabel").textContent = `Nice, ${name}!`;
    $("finalscore").innerHTML = `${data.score}<span> / ${data.total}</span>`;
    $("statslink").href = `/g/${GID}/results`;
    renderLeaderboard(data.leaderboard, name);
    show("done");
  } catch (e) {
    toast("Error submitting — try again");
    btn.disabled = false; btn.textContent = "Submit score";
  }
});

async function showAlreadyPlayed(prev) {
  $("donelabel").textContent = "You already played";
  $("finalscore").innerHTML = `${prev.score}<span> / ${prev.total}</span>`;
  $("statslink").href = `/g/${GID}/results`;
  try {
    const r = await fetch(`/api/games/${GID}/stats`);
    const s = await r.json();
    renderLeaderboard(s.leaderboard, prev.name);
  } catch (_) {}
  show("done");
}

function renderLeaderboard(rows, myName) {
  if (!rows || rows.length === 0) {
    $("lb").innerHTML = `<p class="empty">No scores yet — be the first!</p>`;
    return;
  }
  const medals = ["🥇", "🥈", "🥉"];
  let mineMarked = false;
  const body = rows
    .map((r, i) => {
      const mine = !mineMarked && r.name === myName;
      if (mine) mineMarked = true;
      const rank = i < 3 ? `<span class="medal">${medals[i]}</span>` : i + 1;
      return `<tr class="${mine ? "you" : ""}">
        <td class="rank">${rank}</td>
        <td>${escapeHtml(r.name)}</td>
        <td class="score">${r.score}/${r.total}</td></tr>`;
    })
    .join("");
  $("lb").innerHTML = `<table>
    <thead><tr><th>#</th><th>Player</th><th>Score</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}
