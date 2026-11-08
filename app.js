import { openStore, isDemo } from "./db.js";

// ---------- helpers ----------
const app = document.getElementById("app");
const sheetEl = document.getElementById("sheet");
const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const money = (n) => fmt.format(Number(n) || 0);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const thisMonth = () => todayStr().slice(0, 7);
const addMonths = (m, n) => {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + (mo - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};
const monthsBetween = (a, b) => { const [y1, m1] = a.split("-").map(Number); const [y2, m2] = b.split("-").map(Number); return (y2 - y1) * 12 + (m2 - m1); };
const monthLabel = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
const shortMonth = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" });
const dayLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
// Accepts "1600.50", "1,600.50", "1600,50" and "1.600,50" (iPhones in Spanish type a comma for decimals).
function parseAmount(s) {
  let t = String(s ?? "").replace(/[$\s]/g, "");
  const lastComma = t.lastIndexOf(","), lastDot = t.lastIndexOf(".");
  if (lastComma > lastDot) {
    const decimals = t.length - lastComma - 1;
    t = lastDot >= 0 || decimals !== 3 ? t.replace(/\./g, "").replace(",", "§").replace(/,/g, "").replace("§", ".") : t.replace(/,/g, "");
  } else {
    t = t.replace(/,/g, "");
  }
  if (t === "") return NaN;
  return Math.round(Number(t) * 100) / 100;
}
const num = (x) => Number(x) || 0;

const KIND_LABEL = { expense: "Expense", income: "Deposit", transfer: "Transfer", tuition: "Tuition", tuition_refund: "Tuition discount" };

const S = { store: null, user: null, data: null, view: "home", month: thisMonth(), filter: "all", sheet: null, error: "", busy: false };

// ---------- data helpers ----------
const sortBy = (k) => (a, b) => num(a[k]) - num(b[k]);
const accounts = () => [...S.data.accounts].sort(sortBy("sort"));
const categories = () => [...S.data.categories].sort(sortBy("sort"));
const acctName = (id) => S.data.accounts.find((a) => a.id === id)?.name ?? "—";
const catById = (id) => S.data.categories.find((c) => c.id === id);
const monthTx = (m) => S.data.transactions.filter((t) => String(t.date).startsWith(m));
const findAcct = (re) => accounts().find((a) => re.test(a.name))?.id;

function limitFor(catId, m) {
  let best = null;
  for (const l of S.data.category_limits) {
    if (l.category_id === catId && l.month <= m && (!best || l.month > best.month)) best = l;
  }
  return best ? num(best.amount) : 0;
}

function balances() {
  const bal = Object.fromEntries(S.data.accounts.map((a) => [a.id, num(a.opening_balance)]));
  for (const t of S.data.transactions) {
    const a = num(t.amount);
    if (t.kind === "expense" || t.kind === "tuition") { if (t.account_id in bal) bal[t.account_id] -= a; }
    else if (t.kind === "income" || t.kind === "tuition_refund") { if (t.account_id in bal) bal[t.account_id] += a; }
    else if (t.kind === "transfer") {
      if (t.account_id in bal) bal[t.account_id] -= a;
      if (t.to_account_id in bal) bal[t.to_account_id] += a;
    }
  }
  return bal;
}

const monthsRange = (a, b) => { const out = []; for (let m = a; m <= b; m = addMonths(m, 1)) out.push(m); return out; };
const spentIn = (m) => monthTx(m).reduce((s, t) => s + (t.kind === "expense" ? num(t.amount) : 0), 0);
const totalLimit = (m) => categories().filter((c) => !c.archived).reduce((s, c) => s + limitFor(c.id, m), 0);

// How many times a planned item still counts between `from` and `to`.
// One-off items count in their month (if not done). Monthly items count only future months,
// because this month's real deposit is already in (or about to be added to) the balances.
function plannedCount(p, from, to) {
  if (p.done) return 0;
  if (!p.repeat_until || p.repeat_until <= p.month) return p.month >= from && p.month <= to ? 1 : 0;
  let n = 0;
  for (let m = p.month; m <= p.repeat_until; m = addMonths(m, 1)) if (m > from && m <= to) n++;
  return n;
}

// Money available for day-to-day living from the start of this month until the end of the period.
function projection() {
  const st = S.data.settings[0] || {};
  if (!st.end_month) return null;
  const cur = thisMonth(), end = st.end_month;
  const monthsLeft = monthsBetween(cur, end) + 1;
  if (monthsLeft <= 0) return null;
  const bal = Object.values(balances()).reduce((s, x) => s + x, 0);
  const spentNow = spentIn(cur);
  let plannedIn = 0, plannedOut = 0;
  for (const p of S.data.planned || []) {
    const v = num(p.amount) * plannedCount(p, cur, end);
    if (p.kind === "in") plannedIn += v; else plannedOut += v;
  }
  const pool = bal + spentNow + plannedIn - plannedOut;
  const limitsSum = monthsRange(cur, end).reduce((s, m) => s + totalLimit(m), 0);
  const past = monthsRange(addMonths(cur, -3), addMonths(cur, -1))
    .filter((m) => (!st.start_month || m >= st.start_month) && monthTx(m).some((t) => t.kind === "expense"));
  const avg = past.length ? past.reduce((s, m) => s + spentIn(m), 0) / past.length : null;
  return {
    cur, end, monthsLeft, bal, spentNow, plannedIn, plannedOut, pool,
    perMonth: pool / monthsLeft, limitsSum, endAtLimits: pool - limitsSum,
    avg, avgMonths: past.length, endAtPace: avg == null ? null : pool - avg * monthsLeft,
  };
}

function myName() {
  const e = (S.user?.email || "").toLowerCase();
  return S.data?.allowed_emails?.find((x) => x.email.toLowerCase() === e)?.name || e.split("@")[0] || "";
}

// ---------- loading ----------
async function boot() {
  try {
    S.store = await openStore();
    S.user = await S.store.user();
  } catch (e) {
    app.innerHTML = `<div class="auth"><h1>Couldn't start</h1><p>${esc(e.message)}</p></div>`;
    return;
  }
  if (!S.user) return renderAuth();
  await reload();
}

async function reload() {
  try {
    S.data = await S.store.loadAll();
    if (await generateRecurring()) S.data = await S.store.loadAll();
  } catch (e) {
    S.error = e.message;
  }
  render();
}

// Adds this month's (and any missed months') recurring items automatically.
async function generateRecurring() {
  const today = todayStr();
  const existing = new Set([...S.data.transactions.map((t) => t.recurring_key).filter(Boolean), ...(S.data.deletedKeys || [])]);
  const rows = [];
  for (const r of S.data.recurring) {
    if (!r.active || !r.start_month) continue;
    for (let m = r.start_month; m <= thisMonth(); m = addMonths(m, 1)) {
      const date = `${m}-${pad(r.day)}`;
      if (date > today) break;
      const key = `${r.id}:${m}`;
      if (existing.has(key)) continue;
      rows.push({
        date, kind: r.kind, amount: num(r.amount),
        category_id: r.kind === "expense" ? r.category_id : null,
        account_id: r.account_id, to_account_id: null,
        note: r.name, created_by: "Auto", recurring_key: key,
      });
    }
  }
  if (!rows.length) return false;
  await S.store.addRecurringInstances(rows);
  return true;
}

// ---------- screens ----------
function renderAuth(msg = "", email = "") {
  sheetEl.innerHTML = "";
  app.innerHTML = `
    <div class="auth">
      <div class="logo">$</div>
      <h1>Our Budget</h1>
      <p class="muted">Sign in to see your shared budget.</p>
      <form data-form="auth" novalidate>
        <input type="email" name="email" placeholder="Email" autocomplete="username" autocapitalize="off" value="${esc(email)}">
        <input type="password" name="password" placeholder="Password (at least 6 characters)" autocomplete="current-password">
        <button class="primary" type="submit">Sign in</button>
        <button class="link" type="button" data-action="signup">First time? Create your account</button>
      </form>
      ${msg ? `<p class="msg">${esc(msg)}</p>` : ""}
    </div>`;
}

function authProblem(email, pw) {
  if (!/^\S+@\S+\.\S+$/.test(email)) return "First type your email in the Email box.";
  if (pw.length < 6) return "Type a password of at least 6 characters in the Password box.";
  return "";
}

function render() {
  if (!S.data) return;
  if (!isDemo && !S.data.allowed_emails.length) {
    app.innerHTML = `<div class="auth"><h1>Not on the list</h1>
      <p class="muted">${esc(S.user.email)} isn't one of the allowed emails for this budget. Add it in Supabase (table <b>allowed_emails</b>) and try again.</p>
      <button class="primary" data-action="signout">Sign out</button></div>`;
    return;
  }
  const views = { home: homeView, tx: txView, analysis: analysisView, settings: settingsView };
  const y = window.scrollY;
  app.innerHTML = `
    ${isDemo ? `<div class="banner">Demo mode · fake data, saved only on this device</div>` : ""}
    ${S.error ? `<button class="banner error" data-action="dismiss-error">${esc(S.error)} &nbsp;✕</button>` : ""}
    <main>${views[S.view]()}</main>
    <nav class="tabbar">
      ${tab("home", "◔", "Budget")}
      ${tab("tx", "≡", "Activity")}
      <button class="add" data-action="new-tx" aria-label="Add transaction">+</button>
      ${tab("analysis", "▥", "Analysis")}
      ${tab("settings", "⚙︎", "Settings")}
    </nav>`;
  window.scrollTo(0, y);
  renderSheet();
}

const tab = (v, icon, label) => `<button class="tab ${S.view === v ? "on" : ""}" data-action="view" data-v="${v}"><span>${icon}</span>${label}</button>`;

const monthSwitch = () => `
  <div class="month-switch">
    <button data-action="month" data-n="-1" aria-label="Previous month">‹</button>
    <h1 data-action="month" data-n="0">${monthLabel(S.month)}</h1>
    <button data-action="month" data-n="1" aria-label="Next month">›</button>
  </div>`;

function barClass(pct) { return pct > 100.001 ? "bad" : pct >= 80 ? "warn" : "ok"; }

function homeView() {
  const m = S.month;
  const txs = monthTx(m);
  const spentBy = {};
  let totalSpent = 0, deposits = 0, tuition = 0;
  for (const t of txs) {
    const a = num(t.amount);
    if (t.kind === "expense") { spentBy[t.category_id] = (spentBy[t.category_id] || 0) + a; totalSpent += a; }
    else if (t.kind === "income") deposits += a;
    else if (t.kind === "tuition") tuition += a;
    else if (t.kind === "tuition_refund") tuition -= a;
  }
  const cats = categories().filter((c) => !c.archived || spentBy[c.id]);
  const totalLimit = cats.reduce((s, c) => s + limitFor(c.id, m), 0);
  const left = totalLimit - totalSpent;
  const pct = totalLimit ? (totalSpent / totalLimit) * 100 : 0;

  const bal = balances();
  const total = Object.values(bal).reduce((s, x) => s + x, 0);
  const st = S.data.settings[0] || {};
  let period = `<p class="muted small">Set your 2-year period in <a href="#" data-action="view" data-v="settings">Settings</a> to see how much you can spend per month.</p>`;
  const proj = projection();
  if (proj) {
    period = `<div class="kv"><span>You can spend per month<br><small class="muted">${proj.monthsLeft} month${proj.monthsLeft === 1 ? "" : "s"} left, after planned tuition &amp; income · <a href="#" data-action="view" data-v="analysis">details</a></small></span><b>${money(proj.perMonth)}</b></div>
      <div class="kv"><span>Your monthly limits</span><b>${money(totalLimit)}</b></div>`;
  } else if (st.end_month) {
    period = `<p class="muted small">Your 2-year period ended in ${shortMonth(st.end_month)}.</p>`;
  }

  return `
    ${monthSwitch()}
    <section class="card hero">
      <div class="muted">Left to spend this month</div>
      <div class="big ${left < 0 ? "neg" : ""}">${money(left)}</div>
      <div class="bar"><i class="${barClass(pct)}" style="width:${Math.min(100, pct)}%"></i></div>
      <div class="muted small">Spent ${money(totalSpent)} of ${money(totalLimit)}</div>
      ${!totalLimit ? `<p class="small">No monthly limits yet. <a href="#" data-action="view" data-v="settings">Set them in Settings</a>.</p>` : ""}
    </section>

    <h2>Categories</h2>
    <section class="card list">
      ${cats.map((c) => {
        const lim = limitFor(c.id, m), sp = spentBy[c.id] || 0, l = lim - sp;
        const p = lim ? (sp / lim) * 100 : (sp ? 100 : 0);
        return `<button class="cat" data-action="cat-tx" data-id="${c.id}">
          <div class="row"><span>${esc(c.emoji)} ${esc(c.name)}</span>
            <b class="${l < 0 ? "neg" : ""}">${lim ? (l < 0 ? `${money(-l)} over` : `${money(l)} left`) : `${money(sp)} spent`}</b></div>
          <div class="bar thin"><i class="${barClass(p)}" style="width:${Math.min(100, p)}%"></i></div>
          <div class="muted small">${money(sp)} of ${lim ? money(lim) : "no limit set"}</div>
        </button>`;
      }).join("")}
      ${spentBy.null || spentBy.undefined ? `<div class="cat"><div class="row"><span>• Uncategorized</span><b>${money((spentBy.null || 0) + (spentBy.undefined || 0))}</b></div></div>` : ""}
    </section>

    ${deposits || tuition ? `
    <h2>Outside the monthly budget</h2>
    <section class="card">
      ${deposits ? `<div class="kv"><span>Deposits</span><b class="pos">+${money(deposits)}</b></div>` : ""}
      ${tuition ? `<div class="kv"><span>Tuition${tuition < 0 ? " (net discount)" : ""}</span><b class="${tuition > 0 ? "neg" : "pos"}">${tuition > 0 ? "−" : "+"}${money(Math.abs(tuition))}</b></div>` : ""}
    </section>` : ""}

    <h2>Money in the accounts <small class="muted">(today)</small></h2>
    <section class="card">
      ${accounts().map((a) => `<div class="kv"><span>${esc(a.name)}</span><b>${money(bal[a.id])}</b></div>`).join("")}
      <div class="kv total"><span>Total</span><b>${money(total)}</b></div>
      ${period}
    </section>`;
}

function analysisView() {
  const st = S.data.settings[0] || {};
  const cur = thisMonth();
  const p = projection();
  const signed = (v) => `<b class="${v < 0 ? "neg" : "pos"}">${v < 0 ? "−" : ""}${money(Math.abs(v))}</b>`;

  // 1) On track?
  let track;
  if (!p) {
    track = `<p class="small">Set your 2-year period in <a href="#" data-action="view" data-v="settings">Settings</a> to see this.</p>`;
  } else {
    track = `
      <div class="kv"><span>You can spend per month<br><small class="muted">${shortMonth(cur)} – ${shortMonth(p.end)} · ${p.monthsLeft} months</small></span><b>${money(p.perMonth)}</b></div>
      <div class="kv"><span>Your monthly limits now</span><b>${money(totalLimit(cur))}</b></div>
      <div class="kv"><span>Left in ${shortMonth(p.end)} if you spend exactly your limits</span>${signed(p.endAtLimits)}</div>
      ${p.avg == null
        ? `<p class="muted small">After your first full month of entries, this also shows where you'd end up at your real spending pace.</p>`
        : `<div class="kv"><span>Left in ${shortMonth(p.end)} at your real pace<br><small class="muted">You spent ${money(p.avg)}/month on average (last ${p.avgMonths} month${p.avgMonths === 1 ? "" : "s"})</small></span>${signed(p.endAtPace)}</div>`}
      <details class="how"><summary>How this is calculated</summary>
        <div class="kv"><span>Money in your accounts now</span><b>${money(p.bal)}</b></div>
        <div class="kv"><span>+ Already spent this month</span><b>${money(p.spentNow)}</b></div>
        <div class="kv"><span>+ Planned money coming in</span><b class="pos">+${money(p.plannedIn)}</b></div>
        <div class="kv"><span>− Planned payments</span><b class="neg">−${money(p.plannedOut)}</b></div>
        <div class="kv total"><span>= For living, ${shortMonth(cur)} – ${shortMonth(p.end)}</span><b>${money(p.pool)}</b></div>
      </details>`;
  }
  const planned = [...(S.data.planned || [])].sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));
  const plannedList = S.data.plannedMissing
    ? `<p class="small pad">To use planned money, run the SQL update in Supabase first (see the setup steps from Claude).</p>`
    : `<section class="card list">
        ${planned.map((x) => {
          const past = (x.repeat_until || x.month) < cur;
          const when = x.repeat_until && x.repeat_until > x.month ? `Monthly, ${shortMonth(x.month)} – ${shortMonth(x.repeat_until)}` : shortMonth(x.month);
          return `<button class="item ${x.done || past ? "dim" : ""}" data-action="edit-plan" data-id="${x.id}">
            <span>${esc(x.name)}<small>${when}${x.done ? " · Done" : past ? " · Past" : ""}</small></span>
            <b class="${x.kind === "in" ? "pos" : "neg"}">${x.kind === "in" ? "+" : "−"}${money(x.amount)}</b></button>`;
        }).join("")}
        <button class="item add-row" data-action="new-plan">+ Add planned money</button>
      </section>
      <p class="muted small pad">When a planned payment or deposit really happens, record it in Activity and mark it <b>Done</b> here so it isn't counted twice.</p>`;

  // 2) Month by month
  // Start at the first month with entries or limits (months before you used the app would just be empty).
  const firstUsed = [...S.data.transactions.map((t) => String(t.date).slice(0, 7)), ...S.data.category_limits.map((l) => l.month)].sort()[0] || cur;
  const first = st.start_month && st.start_month > firstUsed ? st.start_month : firstUsed;
  const months = monthsRange(first > cur ? cur : first, cur).slice(-12).reverse();
  const totals = months.map((m) => ({ m, spent: spentIn(m), limit: totalLimit(m) }));
  const full = totals.filter((x) => x.m < cur && x.spent > 0);
  const avgFull = full.length ? full.reduce((s, x) => s + x.spent, 0) / full.length : null;

  // 3) Where the money goes
  const scopeMonths = S.anaScope === "all" ? months : [cur];
  const byCat = {};
  let catTotal = 0;
  for (const m of scopeMonths) for (const t of monthTx(m)) {
    if (t.kind !== "expense") continue;
    byCat[t.category_id] = (byCat[t.category_id] || 0) + num(t.amount);
    catTotal += num(t.amount);
  }
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const top = catRows[0]?.[1] || 1;

  return `
    <h1 class="title">Analysis</h1>

    <h2>On track to ${p ? shortMonth(p.end) : "the end"}?</h2>
    <section class="card">${track}</section>
    <h3>Planned money</h3>
    ${plannedList}

    <h2>Month by month</h2>
    <section class="card list">
      ${totals.map((x) => {
        const pct = x.limit ? (x.spent / x.limit) * 100 : (x.spent ? 100 : 0);
        return `<div class="cat"><div class="row"><span>${monthLabel(x.m)}${x.m === cur ? ' <small class="muted">(so far)</small>' : ""}</span>
          <b class="${x.limit && x.spent > x.limit ? "neg" : ""}">${money(x.spent)}</b></div>
          <div class="bar thin"><i class="${barClass(pct)}" style="width:${Math.min(100, pct)}%"></i></div>
          <div class="muted small">${x.limit ? `${Math.round(pct)}% of ${money(x.limit)}` : "No limits set"}</div></div>`;
      }).join("")}
    </section>
    ${avgFull != null ? `<p class="muted small pad">Average of finished months: <b>${money(avgFull)}</b> per month.</p>` : ""}

    <h2>Where the money goes</h2>
    <div class="seg">
      <button class="${S.anaScope !== "all" ? "on" : ""}" data-action="ana-scope" data-s="month">This month</button>
      <button class="${S.anaScope === "all" ? "on" : ""}" data-action="ana-scope" data-s="all">${months.length > 1 ? `Last ${months.length} months` : "Whole period"}</button>
    </div>
    <section class="card list">
      ${catRows.length ? catRows.map(([id, v]) => {
        const c = catById(id);
        return `<div class="cat"><div class="row"><span>${esc(c?.emoji || "•")} ${esc(c?.name || "Uncategorized")}</span>
          <b>${money(v)} <small class="muted">${Math.round((v / catTotal) * 100)}%</small></b></div>
          <div class="bar thin"><i class="share" style="width:${(v / top) * 100}%"></i></div></div>`;
      }).join("") : `<p class="empty">No spending yet.</p>`}
      ${catRows.length ? `<div class="cat"><div class="row"><span><b>Total</b></span><b>${money(catTotal)}</b></div></div>` : ""}
    </section>`;
}

function planSheet(d) {
  return `
    <div class="seg">
      <button type="button" class="${d.kind === "in" ? "on" : ""}" data-action="plan-kind" data-k="in">Money in</button>
      <button type="button" class="${d.kind === "out" ? "on" : ""}" data-action="plan-kind" data-k="out">Payment</button>
    </div>
    <label class="field">Name <input name="name" value="${esc(d.name)}" placeholder="e.g. Spring tuition"></label>
    <label class="field">Amount <input name="amount" inputmode="decimal" value="${esc(d.amount)}" placeholder="$0.00"></label>
    <label class="field">Month <input type="month" name="month" value="${esc(d.month)}"></label>
    <label class="field">Repeats monthly until <input type="month" name="repeat_until" value="${esc(d.repeat_until || "")}"></label>
    <p class="muted small">Leave "Repeats monthly until" empty for a one-time item.</p>
    ${d.id ? `<label class="check"><input type="checkbox" name="done" ${d.done ? "checked" : ""}> Done (already recorded in Activity)</label>
      <button type="button" class="danger" data-action="delete-plan">Delete planned item</button>` : ""}`;
}

function savePlan() {
  const d = S.sheet.draft;
  const name = (d.name || "").trim();
  const amount = parseAmount(d.amount);
  if (!name) return sheetError("Enter a name.");
  if (!(amount > 0)) return sheetError("Enter an amount.");
  if (!d.month) return sheetError("Choose a month.");
  if (d.repeat_until && d.repeat_until < d.month) return sheetError("\"Repeats until\" must be after the month.");
  const row = { name, kind: d.kind, amount, month: d.month, repeat_until: d.repeat_until || null, done: !!d.done };
  return save(() => d.id ? S.store.update("planned", d.id, row) : S.store.insert("planned", row));
}

function txView() {
  const filters = [["all", "All"], ["expense", "Spending"], ["income", "Deposits"], ["transfer", "Transfers"], ["tuition", "Tuition"]];
  let txs = monthTx(S.month);
  if (S.filter === "tuition") txs = txs.filter((t) => t.kind === "tuition" || t.kind === "tuition_refund");
  else if (S.filter.startsWith("cat:")) txs = txs.filter((t) => t.kind === "expense" && t.category_id === S.filter.slice(4));
  else if (S.filter !== "all") txs = txs.filter((t) => t.kind === S.filter);
  txs.sort((a, b) => (b.date + (b.created_at || "")).localeCompare(a.date + (a.created_at || "")));

  const groups = {};
  for (const t of txs) (groups[t.date] ||= []).push(t);
  const catFilter = S.filter.startsWith("cat:") ? catById(S.filter.slice(4)) : null;

  return `
    ${monthSwitch()}
    <div class="seg scroll">
      ${catFilter ? `<button class="on" data-action="filter" data-f="all">${esc(catFilter.emoji)} ${esc(catFilter.name)} ✕</button>` : ""}
      ${filters.map(([f, l]) => `<button class="${S.filter === f ? "on" : ""}" data-action="filter" data-f="${f}">${l}</button>`).join("")}
    </div>
    ${txs.length ? Object.entries(groups).map(([d, list]) => `
      <h3>${dayLabel(d)}</h3>
      <section class="card list">${list.map(txRow).join("")}</section>`).join("")
      : `<p class="empty">Nothing here for ${monthLabel(S.month)}.<br>Tap <b>+</b> to add a transaction.</p>`}`;
}

function txRow(t) {
  const c = catById(t.category_id);
  let icon = "•", title = t.note, sub = [], sign = "−", cls = "";
  if (t.kind === "expense") { icon = c?.emoji || "•"; title ||= c?.name || "Expense"; sub.push(c?.name || "Uncategorized", acctName(t.account_id)); }
  else if (t.kind === "income") { icon = "💵"; title ||= "Deposit"; sub.push(`Deposit to ${acctName(t.account_id)}`); sign = "+"; cls = "pos"; }
  else if (t.kind === "transfer") { icon = "⇄"; title ||= "Transfer"; sub.push(`${acctName(t.account_id)} → ${acctName(t.to_account_id)}`); sign = ""; cls = "muted"; }
  else if (t.kind === "tuition") { icon = "🎓"; title ||= "Tuition"; sub.push("Tuition", acctName(t.account_id)); }
  else if (t.kind === "tuition_refund") { icon = "🎓"; title ||= "Tuition discount"; sub.push("Tuition discount", acctName(t.account_id)); sign = "+"; cls = "pos"; }
  if (t.created_by) sub.push(t.created_by);
  return `<button class="tx" data-action="edit-tx" data-id="${t.id}">
    <span class="icon">${esc(icon)}</span>
    <span class="main"><b>${esc(title)}</b><small>${esc(sub.join(" · "))}</small></span>
    <span class="amt ${cls}">${sign}${money(t.amount)}</span>
  </button>`;
}

function settingsView() {
  const st = S.data.settings[0] || {};
  const bal = balances();
  const m = thisMonth();
  return `
    <h1 class="title">Settings</h1>

    <h2>2-year period</h2>
    <section class="card">
      <label class="field">Starts <input type="month" data-setting="start_month" value="${esc(st.start_month || "")}"></label>
      <label class="field">Ends <input type="month" data-setting="end_month" value="${esc(st.end_month || "")}"></label>
      <p class="muted small">Used to show how much you can spend per month for the rest of the period.</p>
    </section>

    <h2>Accounts</h2>
    <section class="card list">
      ${accounts().map((a) => `<button class="item" data-action="edit-account" data-id="${a.id}">
        <span>${esc(a.name)}<small>Opening balance ${money(a.opening_balance)}</small></span><b>${money(bal[a.id])}</b></button>`).join("")}
      <button class="item add-row" data-action="new-account">+ Add account</button>
    </section>
    <p class="muted small pad">Opening balance = the balance on the day you start logging transactions in this app.</p>

    <h2>Categories &amp; monthly limits <small class="muted">(${shortMonth(m)})</small></h2>
    <section class="card list">
      ${categories().map((c) => `<button class="item ${c.archived ? "dim" : ""}" data-action="edit-cat" data-id="${c.id}">
        <span>${esc(c.emoji)} ${esc(c.name)}${c.archived ? "<small>Hidden</small>" : ""}</span><b>${money(limitFor(c.id, m))}</b></button>`).join("")}
      <button class="item add-row" data-action="new-cat">+ Add category</button>
    </section>

    <h2>Recurring</h2>
    <section class="card list">
      ${S.data.recurring.map((r) => `<button class="item ${r.active ? "" : "dim"}" data-action="edit-rec" data-id="${r.id}">
        <span>${esc(r.name)}<small>Day ${r.day} of each month · ${esc(acctName(r.account_id))}${r.active ? "" : " · Paused"}</small></span>
        <b class="${r.kind === "income" ? "pos" : ""}">${r.kind === "income" ? "+" : ""}${money(r.amount)}</b></button>`).join("")}
      <button class="item add-row" data-action="new-rec">+ Add recurring item</button>
    </section>
    <p class="muted small pad">Recurring items are added automatically on their day each month (for example rent or streaming).</p>

    <h2>You</h2>
    <section class="card">
      ${isDemo
        ? `<p class="small">Demo mode: nothing is shared yet. Once the database is connected you'll each sign in with your own email.</p>
           <button class="secondary" data-action="reset-demo">Reset demo data</button>`
        : `<div class="kv"><span>Signed in as</span><b>${esc(myName())}</b></div>
           <p class="muted small">${esc(S.user.email)}</p>
           <button class="secondary" data-action="signout">Sign out</button>`}
    </section>`;
}

// ---------- sheets (pop-up forms) ----------
function renderSheet() {
  const s = S.sheet;
  if (!s) { sheetEl.innerHTML = ""; document.body.classList.remove("locked"); return; }
  document.body.classList.add("locked");
  const body = { tx: txSheet, cat: catSheet, account: accountSheet, rec: recSheet, plan: planSheet }[s.type](s.draft);
  sheetEl.innerHTML = `<div class="backdrop" data-action="close"></div>
    <form class="sheet" data-form="${s.type}" novalidate>
      <div class="sheet-head">
        <button type="button" class="link" data-action="close">Cancel</button>
        <b>${esc(s.title)}</b>
        <button type="submit" class="link strong">Save</button>
      </div>
      ${s.error ? `<p class="msg">${esc(s.error)}</p>` : ""}
      ${body}
    </form>`;
}

const options = (list, sel, labelFn = (x) => x.name) => list.map((x) => `<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${esc(labelFn(x))}</option>`).join("");

function txSheet(d) {
  const kinds = [["expense", "Expense"], ["income", "Deposit"], ["transfer", "Transfer"], ["tuition", "Tuition"]];
  const accts = accounts();
  return `
    <div class="seg">${kinds.map(([k, l]) => `<button type="button" class="${d.kind === k ? "on" : ""}" data-action="tx-kind" data-k="${k}">${l}</button>`).join("")}</div>
    ${d.kind === "tuition" ? `<div class="seg small">
      <button type="button" class="${d.tuitionDir !== "refund" ? "on" : ""}" data-action="tuition-dir" data-d="pay">Payment</button>
      <button type="button" class="${d.tuitionDir === "refund" ? "on" : ""}" data-action="tuition-dir" data-d="refund">Discount / refund</button></div>` : ""}
    <input class="amount" name="amount" inputmode="decimal" placeholder="$0.00" value="${esc(d.amount)}" autocomplete="off">
    ${d.kind === "expense" ? `<div class="chips">${categories().filter((c) => !c.archived || c.id === d.category_id).map((c) =>
      `<button type="button" class="${d.category_id === c.id ? "on" : ""}" data-action="tx-cat" data-id="${c.id}">${esc(c.emoji)} ${esc(c.name)}</button>`).join("")}</div>` : ""}
    <label class="field">Date <input type="date" name="date" value="${esc(d.date)}"></label>
    ${d.kind === "transfer"
      ? `<label class="field">From <select name="account_id">${options(accts, d.account_id)}</select></label>
         <label class="field">To <select name="to_account_id">${options(accts, d.to_account_id)}</select></label>`
      : `<label class="field">${d.kind === "income" ? "Deposit to" : d.kind === "tuition" && d.tuitionDir === "refund" ? "Back to" : "Paid with"}
           <select name="account_id">${options(accts, d.account_id)}</select></label>`}
    <label class="field">Note <input name="note" placeholder="${d.kind === "expense" ? "e.g. Trader Joe's" : "Optional"}" value="${esc(d.note)}"></label>
    ${d.kind === "tuition" ? `<p class="muted small">Tuition doesn't use up the monthly budget; it only lowers (or, for a discount, raises) the account balance.</p>` : ""}
    ${d.id ? `<button type="button" class="danger" data-action="delete-tx">Delete transaction</button>` : ""}`;
}

function catSheet(d) {
  return `
    <div class="field-row">
      <label class="field emoji">Icon <input name="emoji" value="${esc(d.emoji)}" maxlength="4"></label>
      <label class="field grow">Name <input name="name" value="${esc(d.name)}" placeholder="e.g. Gym"></label>
    </div>
    <label class="field">Monthly limit <input name="limit" inputmode="decimal" value="${esc(d.limit)}" placeholder="$0.00"></label>
    <label class="field">Starting from <input type="month" name="from" value="${esc(d.from)}"></label>
    <p class="muted small">The limit applies from this month on. Earlier months keep the limit they had, so you can change it any time (for example after an internship or a tuition change).</p>
    ${d.id ? `<label class="check"><input type="checkbox" name="archived" ${d.archived ? "checked" : ""}> Hide this category</label>
      <button type="button" class="danger" data-action="delete-cat">Delete category</button>` : ""}`;
}

function accountSheet(d) {
  return `
    <label class="field">Name <input name="name" value="${esc(d.name)}" placeholder="e.g. Savings"></label>
    <label class="field">Opening balance <input name="opening_balance" inputmode="decimal" value="${esc(d.opening_balance)}" placeholder="$0.00"></label>
    <p class="muted small">The balance on the day you start logging transactions in this app. The app then keeps it up to date from what you enter.</p>
    ${d.id ? `<button type="button" class="danger" data-action="delete-account">Delete account</button>` : ""}`;
}

function recSheet(d) {
  return `
    <div class="seg">
      <button type="button" class="${d.kind === "expense" ? "on" : ""}" data-action="rec-kind" data-k="expense">Expense</button>
      <button type="button" class="${d.kind === "income" ? "on" : ""}" data-action="rec-kind" data-k="income">Deposit</button>
    </div>
    <label class="field">Name <input name="name" value="${esc(d.name)}" placeholder="e.g. Rent"></label>
    <label class="field">Amount <input name="amount" inputmode="decimal" value="${esc(d.amount)}" placeholder="$0.00"></label>
    ${d.kind === "expense" ? `<label class="field">Category <select name="category_id"><option value="">Choose…</option>${options(categories().filter((c) => !c.archived), d.category_id, (c) => `${c.emoji} ${c.name}`)}</select></label>` : ""}
    <label class="field">${d.kind === "income" ? "Deposit to" : "Paid with"} <select name="account_id">${options(accounts(), d.account_id)}</select></label>
    <label class="field">Day of month <input name="day" type="number" min="1" max="28" inputmode="numeric" value="${esc(d.day)}"></label>
    <label class="field">Starting from <input type="month" name="start_month" value="${esc(d.start_month)}"></label>
    <label class="check"><input type="checkbox" name="active" ${d.active ? "checked" : ""}> Active</label>
    ${d.id ? `<button type="button" class="danger" data-action="delete-rec">Delete recurring item</button>` : ""}`;
}

function openSheet(type, title, draft) {
  S.sheet = { type, title, draft, error: "" };
  renderSheet();
  if (type === "tx" && !draft.id) sheetEl.querySelector(".amount")?.focus();
}
function closeSheet() { S.sheet = null; renderSheet(); }
function sheetError(msg) {
  S.sheet.error = msg;
  renderSheet();
  sheetEl.querySelector(".sheet")?.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- saving ----------
async function save(fn) {
  if (S.busy) return;
  S.busy = true;
  try {
    await fn();
    S.sheet = null;
    await reload();
  } catch (e) {
    if (S.sheet) sheetError(e.message); else { S.error = e.message; render(); }
  } finally { S.busy = false; }
}

function saveTx() {
  const d = S.sheet.draft;
  const amount = parseAmount(d.amount);
  if (!(amount > 0)) return sheetError("Enter an amount.");
  if (d.kind === "expense" && !d.category_id) return sheetError("Pick a category.");
  if (!d.date) return sheetError("Pick a date.");
  if (d.kind === "transfer" && d.account_id === d.to_account_id) return sheetError("Choose two different accounts.");
  const row = {
    date: d.date,
    kind: d.kind === "tuition" && d.tuitionDir === "refund" ? "tuition_refund" : d.kind,
    amount,
    category_id: d.kind === "expense" ? d.category_id : null,
    account_id: d.account_id || null,
    to_account_id: d.kind === "transfer" ? d.to_account_id : null,
    note: (d.note || "").trim() || null,
  };
  if (row.kind !== "expense" && !d.id) S.filter = "all";
  return save(() => d.id ? S.store.update("transactions", d.id, row) : S.store.insert("transactions", { ...row, created_by: myName() }));
}

function saveCat() {
  const d = S.sheet.draft;
  const name = (d.name || "").trim();
  if (!name) return sheetError("Enter a name.");
  const hasLimit = String(d.limit ?? "").trim() !== "";
  const limit = parseAmount(d.limit);
  if (hasLimit && !(limit >= 0)) return sheetError("The limit must be a number.");
  if (!d.from) return sheetError("Choose the month the limit starts.");
  return save(async () => {
    let id = d.id;
    const emoji = (d.emoji || "").trim() || "•";
    if (id) await S.store.update("categories", id, { name, emoji, archived: !!d.archived });
    else id = (await S.store.insert("categories", { name, emoji, archived: false, sort: Math.max(0, ...S.data.categories.map((c) => num(c.sort))) + 1 })).id;
    if (hasLimit && limit !== limitFor(id, d.from)) await S.store.setLimit(id, d.from, limit);
  });
}

function saveAccount() {
  const d = S.sheet.draft;
  const name = (d.name || "").trim();
  if (!name) return sheetError("Enter a name.");
  const opening = String(d.opening_balance ?? "").trim() === "" ? 0 : parseAmount(d.opening_balance);
  if (Number.isNaN(opening)) return sheetError("The opening balance must be a number.");
  const row = { name, opening_balance: opening };
  return save(() => d.id ? S.store.update("accounts", d.id, row)
    : S.store.insert("accounts", { ...row, sort: Math.max(0, ...S.data.accounts.map((a) => num(a.sort))) + 1 }));
}

function saveRec() {
  const d = S.sheet.draft;
  const name = (d.name || "").trim();
  const amount = parseAmount(d.amount);
  const day = Number(d.day);
  if (!name) return sheetError("Enter a name.");
  if (!(amount > 0)) return sheetError("Enter an amount.");
  if (d.kind === "expense" && !d.category_id) return sheetError("Choose a category.");
  if (!(day >= 1 && day <= 28)) return sheetError("Day of month must be 1–28.");
  if (!d.start_month) return sheetError("Choose a starting month.");
  const row = { name, kind: d.kind, amount, category_id: d.kind === "expense" ? d.category_id : null, account_id: d.account_id || null, day, start_month: d.start_month, active: !!d.active };
  return save(() => d.id ? S.store.update("recurring", d.id, row) : S.store.insert("recurring", row));
}

// ---------- events ----------
const ACTIONS = {
  view: (el) => { S.view = el.dataset.v; if (S.view !== "tx" && S.filter.startsWith("cat:")) S.filter = "all"; render(); window.scrollTo(0, 0); },
  month: (el) => { const n = Number(el.dataset.n); S.month = n ? addMonths(S.month, n) : thisMonth(); render(); },
  filter: (el) => { S.filter = el.dataset.f; render(); },
  "cat-tx": (el) => { S.filter = `cat:${el.dataset.id}`; S.view = "tx"; render(); window.scrollTo(0, 0); },
  "dismiss-error": () => { S.error = ""; render(); },
  close: closeSheet,

  "new-tx": () => {
    const m = S.month === thisMonth() ? todayStr() : `${S.month}-01`;
    openSheet("tx", "New transaction", { kind: "expense", amount: "", date: m, category_id: S.filter.startsWith("cat:") ? S.filter.slice(4) : null,
      account_id: findAcct(/bofa|bank of america/i) || accounts()[0]?.id, to_account_id: null, note: "", tuitionDir: "pay" });
  },
  "edit-tx": (el) => {
    const t = S.data.transactions.find((x) => x.id === el.dataset.id);
    openSheet("tx", "Edit transaction", { ...t, amount: String(num(t.amount)), note: t.note || "",
      kind: t.kind === "tuition_refund" ? "tuition" : t.kind, tuitionDir: t.kind === "tuition_refund" ? "refund" : "pay" });
  },
  "tx-kind": (el) => {
    const d = S.sheet.draft; d.kind = el.dataset.k;
    if (d.kind === "transfer") {
      d.account_id = findAcct(/pershing/i) || accounts()[0]?.id;
      d.to_account_id = findAcct(/bofa|bank of america/i) || accounts().find((a) => a.id !== d.account_id)?.id;
    }
    renderSheet();
  },
  "tuition-dir": (el) => { S.sheet.draft.tuitionDir = el.dataset.d; renderSheet(); },
  "tx-cat": (el) => { S.sheet.draft.category_id = el.dataset.id; renderSheet(); },
  "delete-tx": () => {
    const d = S.sheet.draft;
    if (!confirm("Delete this transaction?")) return;
    save(() => d.recurring_key ? S.store.update("transactions", d.id, { deleted: true }) : S.store.remove("transactions", d.id));
  },

  "new-cat": () => openSheet("cat", "New category", { name: "", emoji: "", limit: "", from: thisMonth() }),
  "edit-cat": (el) => {
    const c = catById(el.dataset.id);
    openSheet("cat", "Edit category", { ...c, limit: String(limitFor(c.id, thisMonth())), from: thisMonth() });
  },
  "delete-cat": () => {
    const id = S.sheet.draft.id;
    if (S.data.transactions.some((t) => t.category_id === id) || S.data.recurring.some((r) => r.category_id === id))
      return sheetError("This category is used by transactions or recurring items. Hide it instead.");
    if (!confirm("Delete this category?")) return;
    save(() => S.store.remove("categories", id));
  },

  "new-account": () => openSheet("account", "New account", { name: "", opening_balance: "" }),
  "edit-account": (el) => { const a = S.data.accounts.find((x) => x.id === el.dataset.id); openSheet("account", "Edit account", { ...a, opening_balance: String(num(a.opening_balance)) }); },
  "delete-account": () => {
    const id = S.sheet.draft.id;
    if (S.data.transactions.some((t) => t.account_id === id || t.to_account_id === id) || S.data.recurring.some((r) => r.account_id === id))
      return sheetError("This account is used by transactions or recurring items, so it can't be deleted.");
    if (!confirm("Delete this account?")) return;
    save(() => S.store.remove("accounts", id));
  },

  "new-rec": () => openSheet("rec", "New recurring item", { kind: "expense", name: "", amount: "", category_id: null,
    account_id: findAcct(/bofa|bank of america/i) || accounts()[0]?.id, day: "1", start_month: thisMonth(), active: true }),
  "edit-rec": (el) => { const r = S.data.recurring.find((x) => x.id === el.dataset.id); openSheet("rec", "Edit recurring item", { ...r, amount: String(num(r.amount)), day: String(r.day) }); },
  "rec-kind": (el) => { S.sheet.draft.kind = el.dataset.k; renderSheet(); },
  "delete-rec": () => {
    if (!confirm("Delete this recurring item? Transactions already added stay.")) return;
    const id = S.sheet.draft.id;
    save(() => S.store.remove("recurring", id));
  },

  "ana-scope": (el) => { S.anaScope = el.dataset.s; render(); },
  "new-plan": () => openSheet("plan", "New planned item", { kind: "out", name: "", amount: "", month: addMonths(thisMonth(), 1), repeat_until: "", done: false }),
  "edit-plan": (el) => { const x = S.data.planned.find((p) => p.id === el.dataset.id); openSheet("plan", "Edit planned item", { ...x, amount: String(num(x.amount)) }); },
  "plan-kind": (el) => { S.sheet.draft.kind = el.dataset.k; renderSheet(); },
  "delete-plan": () => {
    if (!confirm("Delete this planned item?")) return;
    const id = S.sheet.draft.id;
    save(() => S.store.remove("planned", id));
  },

  "reset-demo": () => { if (confirm("Reset all demo data?")) { S.store.resetDemo(); reload(); } },
  signout: async () => { await S.store.signOut(); S.user = null; S.data = null; renderAuth(); },
  signup: async (el) => {
    const f = el.closest("form");
    const email = f.email.value.trim(), pw = f.password.value;
    const problem = authProblem(email, pw);
    if (problem) return renderAuth(problem, email);
    el.textContent = "Creating account…";
    try {
      const r = await S.store.signUp(email, pw);
      if (r.needsConfirm) renderAuth("Account created. Check your email and tap the confirmation link, then come back here and sign in.", email);
      else { S.user = await S.store.user(); await reload(); }
    } catch (e) { renderAuth(e.message, email); }
  },
};

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  e.preventDefault();
  ACTIONS[el.dataset.action]?.(el);
});

function onField(e) {
  const t = e.target;
  if (t.dataset.setting) {
    if (e.type === "change") save(() => S.store.saveSettings({ [t.dataset.setting]: t.value || null }));
    return;
  }
  if (S.sheet && t.name && t.closest("form.sheet")) S.sheet.draft[t.name] = t.type === "checkbox" ? t.checked : t.value;
}
document.addEventListener("input", onField);
document.addEventListener("change", onField);

document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const form = f.dataset.form;
  if (form === "auth") {
    const email = f.email.value.trim(), pw = f.password.value;
    const problem = authProblem(email, pw);
    if (problem) return renderAuth(problem, email);
    f.querySelector(".primary").textContent = "Signing in…";
    try {
      await S.store.signIn(email, pw);
      S.user = await S.store.user();
      await reload();
    } catch (err) { renderAuth(err.message, email); }
    return;
  }
  ({ tx: saveTx, cat: saveCat, account: saveAccount, rec: saveRec, plan: savePlan })[form]?.();
});

// Refresh when the app comes back to the foreground, so you see each other's entries.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.user && S.data && !S.sheet) reload();
});

boot();
