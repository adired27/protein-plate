// Protein Plate — browser app.
// Talks to Supabase for sign-in and saved meals, and to /api/check for AI photo checks.

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const dayKey = d => d.toLocaleDateString("en-CA");            // YYYY-MM-DD in the user's own timezone
const todayKey = () => dayKey(new Date());
const round = n => Math.round(n * 10) / 10;
const foodKey = n => String(n || "").trim().toLowerCase();

// Protein per unit: per egg, per fistful of nuts (~30 g), per gram of cooked chicken
const P = { eggs: 6, nuts: 6, chicken: 0.27 };
const NAMES = { eggs: "Egg", nuts: "Nuts", chicken: "Chicken" };
const CAMERA_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;

const cfg = window.PP_CONFIG || {};
const configured = !!cfg.supabaseUrl && !!cfg.supabaseAnonKey && !cfg.supabaseUrl.includes("YOUR-PROJECT");
const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;

let userId = null;
let state = { target: 60, days: {} };     // days[YYYY-MM-DD] = { meals: [{id, time, items}] }
let form = { eggs: 0, nuts: 0, chicken: 0 };
let photo = null, check = null, busy = false;

/* ================= auth ================= */

$("#googleBtn").addEventListener("click", async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + location.pathname },
  });
  if (error) $("#signinMsg").textContent = "Couldn't start Google sign-in. Try again.";
});

$("#signout").addEventListener("click", async () => {
  await sb.auth.signOut();
  try { localStorage.removeItem("pp-cache:" + userId); } catch {}
});

if (sb) sb.auth.onAuthStateChange((_event, session) => applySession(session));

function applySession(session){
  const id = session?.user?.id || null;
  if (id === userId) return;
  userId = id;
  $("#signin").hidden = !!id;
  $("#app").hidden = !id;
  if (!id) { state = { target: 60, days: {} }; return; }
  const name = session.user.user_metadata?.full_name || session.user.user_metadata?.name || "";
  $("#hello").textContent = name ? "Hi, " + name.split(" ")[0] : "";
  readCache(); render(); resetForm();
  loadData();
}

/* ================= data ================= */

function readCache(){
  try { const c = JSON.parse(localStorage.getItem("pp-cache:" + userId) || "null"); if (c) state = c; } catch {}
}
function writeCache(){
  try { localStorage.setItem("pp-cache:" + userId, JSON.stringify(state)); } catch {}
}

async function loadData(){
  const since = new Date(); since.setDate(since.getDate() - 13);
  const [mealsRes, profRes] = await Promise.all([
    sb.from("meals").select("id, eaten_on, created_at, items").gte("eaten_on", dayKey(since)).order("created_at"),
    sb.from("profiles").select("target").maybeSingle(),
  ]);
  if (mealsRes.error || profRes.error) { toast("Couldn't load your history. Check your connection."); return; }
  const days = {};
  for (const m of mealsRes.data) (days[m.eaten_on] ||= { meals: [] }).meals.push({ id: m.id, time: m.created_at, items: m.items });
  state = { target: profRes.data?.target || 60, days };
  writeCache(); render();
}

async function saveMeal(items){
  const key = todayKey();
  const { data, error } = await sb.from("meals").insert({ eaten_on: key, items }).select("id, created_at").single();
  if (error) return false;
  (state.days[key] ||= { meals: [] }).meals.push({ id: data.id, time: data.created_at, items });
  writeCache(); render();
  return true;
}

async function saveTarget(n){
  const old = state.target;
  state.target = n; render();
  const { error } = await sb.from("profiles").upsert({ user_id: userId, target: n, updated_at: new Date().toISOString() });
  if (error) { state.target = old; render(); toast("Couldn't save your goal. Try again."); }
  else writeCache();
}

/* ================= math + render ================= */

const itemG = it => (Number(it.protein) || 0) * (Number(it.qty) || 0);
const dayG = key => (state.days[key]?.meals || []).reduce((s, m) => s + m.items.reduce((t, it) => t + itemG(it), 0), 0);

function render(){
  const key = todayKey();
  const total = dayG(key);
  $("#total").textContent = Math.round(total);
  $("#target").textContent = state.target;
  $("#ringFill").style.strokeDashoffset = 502.65 * (1 - Math.min(total / state.target, 1));
  $("#plate").classList.toggle("done", total >= state.target);
  const left = Math.max(0, Math.round(state.target - total));
  $("#status").textContent = total === 0 ? "Nothing logged yet today." : left === 0 ? "Goal reached for today." : `${left} g to go.`;

  const groups = {};
  (state.days[key]?.meals || []).forEach(m => m.items.forEach(it => {
    if (!(it.qty > 0)) return;
    const k = foodKey(it.name);
    const g = groups[k] ||= { name: it.name, unit: it.unit || "", count: 0, grams: 0, last: "" };
    g.count = round(g.count + it.qty); g.grams += itemG(it);
    if (m.time > g.last) g.last = m.time;
  }));
  const rows = Object.entries(groups).sort((a, b) => a[1].last < b[1].last ? 1 : -1);
  $("#meals").innerHTML = rows.length ? rows.map(([k, g]) => `
    <li>
      <div class="what">${esc(g.name)}<span class="count">${g.unit === "g" ? `${Math.round(g.count)} g` : `× ${g.count}`}</span></div>
      <span class="g">${Math.round(g.grams)} g</span>
      <button class="del" data-dec="${esc(k)}" aria-label="${g.unit === "g" ? "Remove last " + esc(g.name) + " entry" : "Remove one " + esc(g.name)}">−</button>
    </li>`).join("") : `<li class="empty">Photo your plate above to log a meal.</li>`;
  renderHistory();
}

function renderHistory(){
  const keys = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); keys.push(dayKey(d)); }
  const totals = keys.map(dayG);
  const max = Math.max(state.target * 1.3, ...totals, 1);
  const bars = $("#bars");
  bars.querySelectorAll(".bar").forEach(b => b.remove());
  keys.forEach((k, i) => {
    const b = document.createElement("div");
    b.className = "bar" + (totals[i] >= state.target ? " hit" : "") + (i === 13 ? " today" : "");
    b.style.height = (totals[i] / max * 100) + "%";
    b.title = `${new Date(k + "T12:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}: ${Math.round(totals[i])} g`;
    bars.appendChild(b);
  });
  $("#goal").style.bottom = (state.target / max * 100) + "%";
  $("#days").innerHTML = keys.map(k => `<span>${new Date(k + "T12:00").toLocaleDateString([], { weekday: "narrow" })}</span>`).join("");
  const week = totals.slice(7), logged = week.filter(t => t > 0);
  $("#avg").textContent = logged.length
    ? `Last 7 days: ${Math.round(logged.reduce((a, b) => a + b, 0) / logged.length)} g a day on average, goal hit on ${week.filter(t => t >= state.target).length} of 7.`
    : "Your daily totals will build up here.";
}

// "−" in the list: remove one egg / fistful, or the latest chicken entry
$("#meals").addEventListener("click", async e => {
  const b = e.target.closest("[data-dec]"); if (!b || busy) return;
  const key = todayKey();
  const meals = state.days[key]?.meals || [];
  const m = [...meals].sort((a, b) => a.time < b.time ? 1 : -1)
    .find(x => x.items.some(i => foodKey(i.name) === b.dataset.dec && i.qty > 0));
  if (!m) return;
  const items = JSON.parse(JSON.stringify(m.items));
  const it = items.find(i => foodKey(i.name) === b.dataset.dec && i.qty > 0);
  it.qty = it.unit === "g" ? 0 : round(it.qty - 1);
  const remaining = items.filter(i => i.qty > 0);
  busy = true;
  const { error } = remaining.length
    ? await sb.from("meals").update({ items: remaining }).eq("id", m.id)
    : await sb.from("meals").delete().eq("id", m.id);
  busy = false;
  if (error) { toast("Couldn't update that. Check your connection."); return; }
  if (remaining.length) m.items = remaining; else state.days[key].meals = meals.filter(x => x !== m);
  writeCache(); render();
});

$("#targetBtn").addEventListener("click", () => {
  const v = prompt("Daily protein goal in grams.\nA common guide is 1 to 1.2 g per kg of body weight.", state.target);
  if (v === null) return;
  const n = Math.round(Number(v));
  if (n >= 10 && n <= 300) saveTarget(n); else toast("Enter a number between 10 and 300.");
});

/* ================= the log form ================= */

function formChanged(){
  $("#v-eggs").textContent = form.eggs;
  $("#v-nuts").textContent = form.nuts;
  if (document.activeElement !== $("#v-chicken")) $("#v-chicken").value = form.chicken;
  if (check && (check.form.eggs !== form.eggs || check.form.nuts !== form.nuts || check.form.chicken !== form.chicken || check.photo !== photo)) {
    check = null; $("#result").hidden = true;
  }
  $("#go").disabled = !photo || busy;
  $("#go").hidden = !!check;
  $("#why").hidden = !!check;
  if (!busy) $("#why").textContent = !photo ? "Add a photo to continue." : "Your numbers are checked against the photo before they're added.";
}

document.querySelectorAll(".stepper").forEach(s => s.addEventListener("click", e => {
  const b = e.target.closest("[data-d]"); if (!b) return;
  const k = s.dataset.k, step = Number(s.dataset.step);
  form[k] = Math.max(0, Math.min(20, round(form[k] + Number(b.dataset.d) * step)));
  formChanged();
}));
$("#v-chicken").addEventListener("input", e => {
  form.chicken = Math.max(0, Math.min(1000, Math.round(Number(e.target.value) || 0)));
  formChanged();
});
$("#v-chicken").addEventListener("blur", () => { $("#v-chicken").value = form.chicken; });
$("#presets").addEventListener("click", e => {
  const b = e.target.closest("[data-g]"); if (!b) return;
  form.chicken = Number(b.dataset.g); formChanged();
});

$("#shot").addEventListener("click", () => $("#file").click());
$("#retake").addEventListener("click", () => $("#file").click());
$("#file").addEventListener("change", e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  photo = f;
  const prev = $("#shot img"); if (prev) URL.revokeObjectURL(prev.src);
  $("#shot").classList.add("has");
  $("#shot").innerHTML = `<img src="${URL.createObjectURL(f)}" alt="Your meal photo">`;
  $("#retake").hidden = false;
  formChanged();
});

// Shrink the photo before upload: faster, cheaper, and under the server's size limit.
function shrink(file, max = 1280){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image")); };
    img.src = url;
  });
}

const ERRORS = {
  daily_limit: "You've used today's photo checks. They reset tomorrow.",
  budget: "Photo checks are paused for now. Try again later.",
  busy: "The checker is busy. Try again in a minute.",
  bad_photo: "That photo couldn't be read. Try a regular photo from your camera.",
  unauthorized: "Your sign-in expired. Sign in again.",
  unreadable: "Couldn't read this plate. Try a clearer photo from above.",
};

$("#go").addEventListener("click", async () => {
  if (!photo || busy) return;
  busy = true;
  const snapshot = { ...form };
  $("#go").disabled = true; $("#go").textContent = "Checking your plate…";
  $("#why").textContent = "This usually takes a few seconds.";
  try {
    const image = await shrink(photo).catch(() => null);
    if (!image) throw { code: "bad_photo" };
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw { code: "unauthorized" };
    const r = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
      body: JSON.stringify({ image, ...snapshot, note: $("#note").value.trim() }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: out.error || "upstream" };
    check = { form: snapshot, photo, photoOk: out.photo_ok, note: out.note, checks: out.checks,
              others: (out.others || []).map(o => ({ ...o, keep: true })) };
    if (typeof out.remaining === "number") {
      $("#left").hidden = false;
      $("#left").textContent = `${out.remaining} photo check${out.remaining === 1 ? "" : "s"} left today.`;
    }
    busy = false;
    renderCheck();
  } catch (e) {
    busy = false;
    const msg = ERRORS[e?.code] || "Connection problem. Tap Check and add again.";
    toast(msg); $("#why").textContent = msg;
    if (e?.code === "unauthorized") sb.auth.signOut();
  } finally {
    $("#go").textContent = "Check and add";
    $("#go").disabled = !photo || busy;
  }
});

const amountText = (k, n) => k === "chicken" ? `${n} g` : k === "nuts" ? `${n} fist${n === 1 ? "" : "s"}` : `${n} egg${n === 1 ? "" : "s"}`;

function renderCheck(){
  const r = $("#result");
  r.hidden = false;
  if (!check.photoOk) {
    r.innerHTML = `<div class="check bad"><span class="mark">!</span><strong>Can't judge this photo</strong><span></span>
      <span class="reason">${esc(check.note || "Retake it from above with the whole plate in view.")}</span></div>
      <div class="row"><button class="btn primary" id="retake2">Retake photo</button></div>`;
    $("#retake2").onclick = () => $("#file").click();
    formChanged(); return;
  }
  const flagged = Object.keys(NAMES).filter(k => check.checks[k].verdict !== "ok");
  const lines = Object.keys(NAMES).filter(k => form[k] > 0 || check.checks[k].verdict !== "ok").map(k => {
    const c = check.checks[k], ok = c.verdict === "ok";
    const head = ok ? `${NAMES[k]}: ${amountText(k, form[k])}` :
      c.verdict === "not_seen" ? `${NAMES[k]}: not in the photo` :
      c.verdict === "too_high" ? `${NAMES[k]}: photo shows less` : `${NAMES[k]}: photo shows more`;
    return `<div class="check ${ok ? "ok" : "bad"}">
      <span class="mark">${ok ? "✓" : "!"}</span><strong>${esc(head)}</strong>
      <span class="g">${ok ? Math.round(form[k] * P[k]) + " g" : ""}</span>
      ${ok ? "" : `<span class="reason">You entered ${esc(amountText(k, form[k]))}. It looks like about ${esc(amountText(k, c.estimate))}.${c.reason ? " " + esc(c.reason) : ""}</span>
        <button class="useai" data-use="${k}">Use ${esc(amountText(k, c.estimate))}</button>`}
    </div>`;
  }).join("");
  const others = check.others.map((o, i) => `
    <div class="check ${o.keep ? "ok" : ""}">
      <span class="mark">${o.keep ? "✓" : "–"}</span><strong>${esc(o.name)}</strong><span class="g">${o.keep ? Math.round(o.protein) + " g" : ""}</span>
      <span class="reason">${esc(o.portion)} · spotted in photo · <button class="linkbtn" data-other="${i}">${o.keep ? "Don't count" : "Count it"}</button></span>
    </div>`).join("");
  const total = Object.keys(NAMES).reduce((s, k) => s + form[k] * P[k], 0) + check.others.filter(o => o.keep).reduce((s, o) => s + o.protein, 0);
  r.innerHTML = `${lines}${others}
    ${!lines && !others ? `<p class="small">Nothing with protein to add. Enter your eggs, nuts or chicken above.</p>` : ""}
    ${flagged.length ? `<p class="small">Fix the flagged ${flagged.length > 1 ? "items" : "item"} to continue: tap Use, or change your number above and check again.</p>` : ""}
    <div class="row">
      <button class="btn" id="cancelBtn">Cancel</button>
      <button class="btn primary" id="addBtn" ${flagged.length || total <= 0 ? "disabled" : ""}>Add ${Math.round(total)} g</button>
    </div>`;
  formChanged();
}

$("#result").addEventListener("click", async e => {
  const use = e.target.closest("[data-use]");
  if (use) {
    const k = use.dataset.use, c = check.checks[k];
    form[k] = c.estimate; c.verdict = "ok";          // the AI's own number is accepted as is
    check.form = { ...form };
    renderCheck(); return;
  }
  const oth = e.target.closest("[data-other]");
  if (oth) { const o = check.others[+oth.dataset.other]; o.keep = !o.keep; renderCheck(); return; }
  if (e.target.closest("#cancelBtn")) { resetForm(); return; }
  const add = e.target.closest("#addBtn");
  if (add && !busy) {
    const items = [];
    if (form.eggs > 0) items.push({ name: "Egg", protein: P.eggs, qty: form.eggs });
    if (form.nuts > 0) items.push({ name: "Nuts", protein: P.nuts, qty: form.nuts });
    if (form.chicken > 0) items.push({ name: "Chicken", unit: "g", protein: P.chicken, qty: form.chicken });
    check.others.filter(o => o.keep).forEach(o => items.push({ name: o.name, portion: o.portion, protein: round(o.protein), qty: 1 }));
    busy = true; add.disabled = true; add.textContent = "Saving…";
    const ok = await saveMeal(items);
    busy = false;
    if (ok) { toast(`Added ${Math.round(items.reduce((s, it) => s + itemG(it), 0))} g`); resetForm(); }
    else { toast("Couldn't save this meal. Check your connection and tap Add again."); renderCheck(); }
  }
});

function resetForm(){
  form = { eggs: 0, nuts: 0, chicken: 0 }; check = null; photo = null;
  const prev = $("#shot img"); if (prev) URL.revokeObjectURL(prev.src);
  $("#shot").classList.remove("has");
  $("#shot").innerHTML = `${CAMERA_ICON}<strong>Photo your plate</strong><span>Required. Shoot from above.</span>`;
  $("#retake").hidden = true; $("#note").value = "";
  $("#result").hidden = true; $("#result").innerHTML = "";
  $("#v-chicken").value = 0;
  formChanged();
}

let toastT;
function toast(msg){
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2800);
}

/* ================= start ================= */

if (!configured) {
  $("#signin").hidden = false;
  $("#googleBtn").disabled = true;
  $("#signinMsg").textContent = "Setup needed: add your Supabase URL and key to config.js.";
} else {
  sb.auth.getSession().then(({ data }) => { if (!data.session) { $("#signin").hidden = false; } else applySession(data.session); });
}

// Roll the view over at midnight, and refresh when the app comes back to the foreground
let lastDay = todayKey();
setInterval(() => { if (todayKey() !== lastDay) { lastDay = todayKey(); if (userId) render(); } }, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && userId) loadData(); });
