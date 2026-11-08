// Data layer. Same interface for the real Supabase database and the local demo.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const TABLES = ["settings", "accounts", "categories", "category_limits", "recurring", "transactions", "allowed_emails"];

export const isDemo = !SUPABASE_URL || !SUPABASE_ANON_KEY || new URLSearchParams(location.search).has("demo");

// ---------- Supabase ----------
function supabaseStore(sb) {
  const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return {
    async user() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }));
    },
    async signUp(email, password) {
      const data = check(await sb.auth.signUp({ email, password }));
      return { needsConfirm: !data.session };
    },
    async signOut() { await sb.auth.signOut(); },
    async loadAll() {
      const out = {};
      await Promise.all(TABLES.map(async (t) => {
        out[t] = check(await sb.from(t).select("*"));
      }));
      // "planned" was added later; keep working if that SQL update hasn't been run yet.
      const planned = await sb.from("planned").select("*");
      out.planned = planned.error ? [] : planned.data;
      out.plannedMissing = !!planned.error;
      out.deletedKeys = out.transactions.filter((t) => t.deleted && t.recurring_key).map((t) => t.recurring_key);
      out.transactions = out.transactions.filter((t) => !t.deleted);
      return out;
    },
    async insert(table, row) { return check(await sb.from(table).insert(row).select().single()); },
    async update(table, id, patch) { check(await sb.from(table).update(patch).eq("id", id)); },
    async remove(table, id) { check(await sb.from(table).delete().eq("id", id)); },
    async saveSettings(patch) { check(await sb.from("settings").upsert({ id: 1, ...patch })); },
    async setLimit(category_id, month, amount) {
      check(await sb.from("category_limits").upsert({ category_id, month, amount }));
    },
    async addRecurringInstances(rows) {
      if (!rows.length) return;
      check(await sb.from("transactions").upsert(rows, { onConflict: "recurring_key", ignoreDuplicates: true }));
    },
  };
}

// ---------- Local demo (fake data, this device only) ----------
const DEMO_KEY = "our-budget-demo-v1";
const uid = () => crypto.randomUUID();

function demoSeed() {
  const today = new Date();
  const ym = (d) => d.toISOString().slice(0, 7);
  const thisMonth = ym(today);
  const accounts = [
    { id: uid(), name: "Pershing", opening_balance: 50000, sort: 1 },
    { id: uid(), name: "BofA", opening_balance: 8000, sort: 2 },
  ];
  const cats = [
    ["Housing", "🏠", 1600], ["Food", "🛒", 600], ["Party & Dinners", "🍷", 250],
    ["Trips & Adventures", "✈️", 300], ["Leo", "🐕", 120], ["Transportation", "🚇", 150],
    ["Pharmacy", "💊", 60], ["AI", "🤖", 40], ["Streaming", "📺", 35],
    ["Extras", "🛍️", 200], ["Presents", "🎁", 80],
  ].map(([name, emoji, limit], i) => ({ id: uid(), name, emoji, sort: i + 1, archived: false, limit }));
  const c = Object.fromEntries(cats.map((x) => [x.name, x.id]));
  const day = (n) => `${thisMonth}-${String(Math.min(n, today.getDate())).padStart(2, "0")}`;
  const [P, B] = accounts.map((a) => a.id);
  const tx = (date, kind, amount, extra) => ({ id: uid(), date, kind, amount, category_id: null, account_id: B, to_account_id: null, note: "", created_by: "Demo", recurring_key: null, deleted: false, created_at: new Date().toISOString(), ...extra });
  const recurringRent = { id: uid(), name: "Rent", kind: "expense", amount: 1600, category_id: c.Housing, account_id: B, day: 1, start_month: thisMonth, active: true };
  return {
    settings: [{ id: 1, start_month: null, end_month: null }],
    accounts,
    categories: cats.map(({ limit, ...rest }) => rest),
    category_limits: cats.map((x) => ({ category_id: x.id, month: thisMonth, amount: x.limit })),
    recurring: [recurringRent],
    allowed_emails: [{ email: "demo@example.com", name: "Demo" }],
    transactions: [
      tx(day(2), "transfer", 3000, { account_id: P, to_account_id: B, note: "Monthly transfer" }),
      tx(day(3), "expense", 84.32, { category_id: c.Food, note: "Trader Joe's" }),
      tx(day(4), "expense", 22.5, { category_id: c.Transportation, note: "CharlieCard" }),
      tx(day(5), "expense", 96.1, { category_id: c["Party & Dinners"], note: "Dinner in the North End", account_id: P }),
      tx(day(6), "expense", 45, { category_id: c.Leo, note: "Dog food" }),
      tx(day(7), "expense", 20, { category_id: c.AI, note: "Claude Plus" }),
      tx(day(7), "expense", 131.4, { category_id: c.Food, note: "Whole Foods" }),
      tx(day(8), "expense", 15.49, { category_id: c.Streaming, note: "Netflix" }),
    ],
  };
}

function demoPlanned() {
  const p = (name, kind, amount, month, repeat_until = null) => ({ id: uid(), name, kind, amount, month, repeat_until, done: false });
  return [
    p("Monthly income (after taxes)", "in", 3100, "2026-12", "2028-06"),
    p("Fall 2026 tuition, installment 3 of 3", "out", 8901.92, "2026-12"),
    p("Spring 2027 tuition + health plan", "out", 26500, "2027-01"),
    p("College Ave loan, year 1", "in", 15000, "2027-01"),
    p("Summer internship (after taxes)", "in", 25000, "2027-08"),
    p("Fall 2027 tuition + health plan", "out", 41500, "2027-08"),
    p("College Ave loan, year 2, part 1", "in", 20000, "2027-08"),
    p("Spring 2028 tuition + health plan", "out", 41500, "2028-01"),
    p("College Ave loan, year 2, part 2", "in", 20000, "2028-01"),
  ];
}

function demoStore() {
  let db;
  const load = () => {
    try { db = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch { db = null; }
    if (!db) { db = demoSeed(); save(); }
    db.planned ||= demoPlanned();
  };
  const save = () => { try { localStorage.setItem(DEMO_KEY, JSON.stringify(db)); } catch {} };
  load();
  return {
    async user() { return { email: "demo@example.com" }; },
    async signIn() {}, async signUp() { return {}; }, async signOut() {},
    async loadAll() {
      load();
      const copy = structuredClone(db);
      copy.deletedKeys = copy.transactions.filter((t) => t.deleted && t.recurring_key).map((t) => t.recurring_key);
      copy.transactions = copy.transactions.filter((t) => !t.deleted);
      return copy;
    },
    async insert(table, row) { const r = { id: uid(), ...row }; db[table].push(r); save(); return r; },
    async update(table, id, patch) { const r = db[table].find((x) => x.id === id); Object.assign(r, patch); save(); },
    async remove(table, id) {
      db[table] = db[table].filter((x) => x.id !== id);
      if (table === "categories") db.category_limits = db.category_limits.filter((l) => l.category_id !== id);
      save();
    },
    async saveSettings(patch) { Object.assign(db.settings[0], patch); save(); },
    async setLimit(category_id, month, amount) {
      const l = db.category_limits.find((x) => x.category_id === category_id && x.month === month);
      if (l) l.amount = amount; else db.category_limits.push({ category_id, month, amount });
      save();
    },
    async addRecurringInstances(rows) {
      for (const r of rows) {
        if (!db.transactions.some((t) => t.recurring_key === r.recurring_key)) db.transactions.push({ id: uid(), deleted: false, ...r });
      }
      save();
    },
    resetDemo() { db = demoSeed(); save(); },
  };
}

export async function openStore() {
  if (isDemo) return demoStore();
  const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm");
  return supabaseStore(createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
}
