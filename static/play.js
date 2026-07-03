// ---- Pixel Reveal — player ----
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

function loadQuestion() {
  locked = false;
  const q = game.questions[idx];
  const shot = $("shot");
  shot.classList.remove("crisp");
  shot.src = `/api/questions/${q.id}/pixel.png`;
  $("hint").textContent = "Tap your guess";
  hide("next");

  const box = $("choices");
  box.innerHTML = "";
  q.options.forEach((opt, i) => {
    const b = document.createElement("button");
    b.className = "choice";
    b.textContent = opt;
    b.addEventListener("click", () => pick(i, b));
    box.appendChild(b);
  });
  renderProgress();
}

async function pick(choiceIdx, btn) {
  if (locked) return;
  locked = true;
  const q = game.questions[idx];
  myAnswers.push({ question_id: q.id, chosen_index: choiceIdx });

  // fetch the correct answer only now that a guess is committed
  let correct = -1;
  try {
    const r = await fetch(`/api/questions/${q.id}/answer`);
    correct = (await r.json()).correct_index;
  } catch (_) {}

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

  // reveal crisp image
  const shot = $("shot");
  shot.classList.add("crisp");
  shot.src = `/api/questions/${q.id}/crisp.png`;

  $("next").textContent = idx + 1 < game.questions.length ? "Next →" : "Finish →";
  show("next");
}

$("next").addEventListener("click", () => {
  idx++;
  if (idx < game.questions.length) {
    loadQuestion();
  } else {
    hide("game");
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
