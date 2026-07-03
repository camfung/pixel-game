// ---- Pixel Reveal — live stats / leaderboard ----
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
$("logo").innerHTML = LOGO_COLORS.map((c) => `<i style="background:${c}"></i>`).join("");

const GID = location.pathname.split("/")[2];
$("playlink").href = `/g/${GID}`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function load() {
  let s;
  try {
    const r = await fetch(`/api/games/${GID}/stats`);
    if (!r.ok) throw new Error();
    s = await r.json();
  } catch (e) {
    document.querySelector(".wrap").innerHTML =
      `<div class="banner err">Couldn't load stats for this game.</div><a class="arrow-link" href="/">Build a game</a>`;
    return;
  }

  $("title").textContent = s.title;
  $("plays").textContent = `${s.play_count} play${s.play_count === 1 ? "" : "s"}`;
  renderLeaderboard(s.leaderboard);
  renderStats(s.questions);
}

function renderLeaderboard(rows) {
  if (!rows || rows.length === 0) {
    $("lb").innerHTML = `<p class="empty">No scores yet — share the link to get players.</p>`;
    return;
  }
  const medals = ["🥇", "🥈", "🥉"];
  const body = rows
    .map((r, i) => {
      const rank = i < 3 ? `<span class="medal">${medals[i]}</span>` : i + 1;
      return `<tr>
        <td class="rank">${rank}</td>
        <td>${escapeHtml(r.name)}</td>
        <td class="score">${r.score}/${r.total}</td></tr>`;
    })
    .join("");
  $("lb").innerHTML = `<table>
    <thead><tr><th>#</th><th>Player</th><th>Score</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function renderStats(questions) {
  if (!questions || questions.length === 0) {
    $("stats").innerHTML = `<p class="empty">No questions.</p>`;
    return;
  }
  $("stats").innerHTML = questions
    .map((q, qi) => {
      const total = q.answered || 0;
      const rows = q.options
        .map((opt, i) => {
          const n = q.counts[i] || 0;
          const pct = total ? Math.round((100 * n) / total) : 0;
          const isCorrect = i === q.correct_index;
          return `<div class="statrow">
            <div class="txt ${isCorrect ? "is-correct" : ""}">
              <span>${isCorrect ? "✓ " : ""}<b>${escapeHtml(opt)}</b></span>
              <span class="n">${n} · ${pct}%</span>
            </div>
            <div class="bar ${isCorrect ? "correct" : ""}"><span style="width:${pct}%"></span></div>
          </div>`;
        })
        .join("");
      return `<div class="statblock">
        <div class="qhead">
          <img src="/api/questions/${q.id}/crisp.png" alt="">
          <div>
            <div class="muted small">Image ${qi + 1} · ${total} guess${total === 1 ? "" : "es"}</div>
            <div><b>${q.pct_correct}%</b> got it right</div>
          </div>
        </div>
        ${rows}
      </div>`;
    })
    .join("");
}

$("refresh").addEventListener("click", load);
$("share").addEventListener("click", async () => {
  const url = `${location.origin}/g/${GID}`;
  try { await navigator.clipboard.writeText(url); toast("Share link copied"); }
  catch { toast(url); }
});

load();
