// ---- Pixelizer — site admin: list and delete any game ----
// Gate: the value of localStorage["12321"] is sent as X-Admin-Token on every
// request; the server decides whether it is right. Without it the page shows
// nothing and the API answers 404, so there is no admin surface to probe.
const LOGO_COLORS = [
  "#1d2b1f", "#bfea4b", "#1d2b1f",
  "#bfea4b", "#c53a20", "#bfea4b",
  "#1d2b1f", "#bfea4b", "#1d2b1f",
];
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
$("logo").innerHTML = LOGO_COLORS.map((c) => `<i style="background:${c}"></i>`).join("");

const TOKEN = localStorage.getItem("12321") || "";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const when = (t) => new Date(t * 1000).toLocaleDateString();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), "X-Admin-Token": TOKEN },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function render(games) {
  if (!games.length) {
    $("empty").classList.remove("hidden");
    $("list").innerHTML = "";
    return;
  }
  $("empty").classList.add("hidden");
  $("list").innerHTML = games.map((g) => `
    <div class="admin-row" data-gid="${g.id}">
      <div class="admin-thumb">
        ${g.cover_qid ? `<img src="/api/questions/${g.cover_qid}/pixel.png" alt="" loading="lazy">` : ""}
      </div>
      <div class="admin-info">
        <div class="admin-title"><a href="/g/${g.id}" target="_blank">${escapeHtml(g.title)}</a></div>
        <div class="admin-meta">
          ${g.id} · ${plural(g.question_count, "image")} · ${plural(g.play_count, "play")}
          · ${g.owner_name ? "by " + escapeHtml(g.owner_name) : "anonymous"} · ${when(g.created_at)}
        </div>
      </div>
      <button class="btn-danger" data-del="${g.id}" data-title="${escapeHtml(g.title)}">Delete</button>
    </div>`).join("");
}

async function load() {
  let games;
  try {
    games = (await api("/api/admin/games")).games || [];
  } catch {
    $("denied").classList.remove("hidden");
    return;
  }
  $("panel").classList.remove("hidden");
  render(games);
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del]");
  if (!btn) return;
  if (!confirm(`Delete "${btn.dataset.title}" and all its plays? This cannot be undone.`)) return;
  btn.disabled = true;
  try {
    await api(`/api/admin/games/${btn.dataset.del}`, { method: "DELETE" });
    document.querySelector(`.admin-row[data-gid="${btn.dataset.del}"]`)?.remove();
    if (!document.querySelector(".admin-row")) $("empty").classList.remove("hidden");
  } catch (err) {
    btn.disabled = false;
    alert("Delete failed: " + err.message);
  }
});

load();
