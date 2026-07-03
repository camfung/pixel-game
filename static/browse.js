// ---- Pixel Reveal — browse published games ----
const LOGO_COLORS = [
  "#1d2b1f", "#bfea4b", "#1d2b1f",
  "#bfea4b", "#c53a20", "#bfea4b",
  "#1d2b1f", "#bfea4b", "#1d2b1f",
];
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
$("logo").innerHTML = LOGO_COLORS.map((c) => `<i style="background:${c}"></i>`).join("");

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---- top-right auth chip (shared shape with the builder) ----
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
  } else if (me.enabled) {
    box.innerHTML = `<a class="btn btn-ghost gbtn" href="/auth/login?next=%2Fbrowse">Sign in with Google</a>`;
  }
}

// ---- game grid ----
async function load() {
  let games = [];
  try { games = (await fetch("/api/browse").then((r) => r.json())).games || []; } catch {}
  if (!games.length) { $("empty").classList.remove("hidden"); return; }
  $("grid").innerHTML = games.map((g) => `
    <a class="gamecard" href="/g/${g.id}">
      <div class="gamecard-img">
        ${g.cover_qid ? `<img src="/api/questions/${g.cover_qid}/pixel.png" alt="" loading="lazy">` : ""}
      </div>
      <div class="gamecard-body">
        <div class="gamecard-title">${escapeHtml(g.title)}</div>
        <div class="gamecard-meta">
          <span>${plural(g.question_count, "image")}</span><span>·</span><span>${plural(g.play_count, "play")}</span>
        </div>
        <div class="gamecard-by">${g.owner_name ? "by " + escapeHtml(g.owner_name) : "anonymous"}</div>
      </div>
    </a>`).join("");
}

initAuth();
load();
