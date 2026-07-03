// ---- Pixelizer — deploy/version footer (shared across pages) ----
(async function () {
  let info = {};
  try { info = await fetch("/api/version").then((r) => r.json()); } catch (_) {}
  const bits = [];
  if (info.version) bits.push("v" + info.version);
  if (info.started) bits.push("updated " + info.started + " UTC");
  const el = document.createElement("footer");
  el.className = "appfooter";
  el.textContent = "Pixelizer" + (bits.length ? " · " + bits.join(" · ") : "");
  document.body.appendChild(el);
})();
