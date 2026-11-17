import { html, render, useState, useEffect, useMemo, useRef, useCallback } from 'https://unpkg.com/htm@3.1.1/preact/standalone.module.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

// ---------------------------------------------------------------------
// Kategorien: Haltbarkeit in Tagen (ab Einkauf), im Gefrierfach,
// nach dem Öffnen und nach dem Auftauen. Alles Schätzwerte.
// ---------------------------------------------------------------------
const CATS = [
  { key: 'milch',     name: 'Milchprodukte',          days: 14,  freezer: 90,  opened: 3,  tint: '#E4EEF5' },
  { key: 'kaese',     name: 'Käse',                   days: 21,  freezer: 90,  opened: 7,  tint: '#FBE7B5' },
  { key: 'eier',      name: 'Eier',                   days: 21,  freezer: 90,  opened: 2,  tint: '#F2EEE4' },
  { key: 'fleisch',   name: 'Fleisch & Wurst',        days: 4,   freezer: 120, opened: 2,  tint: '#F4C9C3', verbrauch: true, thaw: 1 },
  { key: 'fisch',     name: 'Fisch',                  days: 2,   freezer: 90,  opened: 1,  tint: '#D6E4F0', verbrauch: true, thaw: 1 },
  { key: 'obst',      name: 'Obst & Gemüse',          days: 7,   freezer: 240, opened: 3,  tint: '#DCEBD9' },
  { key: 'brot',      name: 'Brot & Backwaren',       days: 4,   freezer: 90,  opened: 4,  tint: '#F4E7D3' },
  { key: 'tk',        name: 'Tiefkühlware',           days: 180, freezer: 180, opened: 2,  tint: '#D3E3F3' },
  { key: 'trocken',   name: 'Nudeln, Reis & Co.',     days: 365, freezer: 365, opened: 180, tint: '#F7EBCB' },
  { key: 'konserve',  name: 'Konserven & Gläser',     days: 540, freezer: 90,  opened: 4,  tint: '#E9E2F2' },
  { key: 'aufstrich', name: 'Aufstriche & Saucen',    days: 180, freezer: 90,  opened: 30, tint: '#FAD3B8' },
  { key: 'backen',    name: 'Backzutaten & Öl',       days: 365, freezer: 365, opened: 180, tint: '#F2EEE4' },
  { key: 'getraenke', name: 'Getränke',               days: 180, freezer: 90,  opened: 5,  tint: '#E3F0E7' },
  { key: 'suess',     name: 'Süßes & Snacks',         days: 120, freezer: 120, opened: 14, tint: '#F7D9D6' },
  { key: 'reste',     name: 'Selbstgekocht & Reste',  days: 3,   freezer: 90,  opened: 3,  tint: '#FBEFB8', thaw: 2 },
  { key: 'sonstiges', name: 'Sonstiges',              days: 30,  freezer: 90,  opened: 7,  tint: '#ECEAE3' }
];
const CAT = Object.fromEntries(CATS.map(c => [c.key, c]));
const catOf = p => CAT[p && p.category] || CAT.sonstiges;

const KINDS = [
  { key: 'fridge',  name: 'Kühlschrank' },
  { key: 'freezer', name: 'Gefrierfach / -truhe' },
  { key: 'pantry',  name: 'Speisekammer / Schrank' },
  { key: 'shelf',   name: 'Regal' }
];

// ---------------------------------------------------------------------
// Datum (immer lokale Zeit, nie UTC)
// ---------------------------------------------------------------------
const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const todayISO = () => toISO(today());
const addDays = n => { const d = today(); d.setDate(d.getDate() + n); return toISO(d); };
const daysLeft = s => Math.round((fromISO(s) - today()) / 86400000);
const fmtDate = s => { const d = fromISO(s); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`; };
const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);

function estimateDays(product, loc) {
  const c = catOf(product);
  if (loc && loc.kind === 'freezer' && c.key !== 'tk') return c.freezer || 90;
  return product.default_days || c.days;
}

function pillFor(s) {
  if (!s.best_before) return { text: 'ohne Datum', tone: 'grey' };
  const d = daysLeft(s.best_before);
  const pre = s.estimated ? '≈ ' : '';
  if (d < 0) return s.expiry_kind === 'verbrauch'
    ? { text: 'abgelaufen', tone: 'red' }
    : { text: 'MHD vorbei · prüfen', tone: 'amber' };
  if (d === 0) return { text: 'heute', tone: 'red' };
  if (d === 1) return { text: 'morgen', tone: 'red' };
  if (d <= 3) return { text: `${pre}${d} Tage`, tone: 'amber' };
  if (d <= 45) return { text: `${pre}${d} Tage`, tone: 'green' };
  return { text: `${pre}${fmtDate(s.best_before)}`, tone: 'green' };
}
const isSoon = s => s.best_before && daysLeft(s.best_before) <= 3;

// ---------------------------------------------------------------------
// Datenbank-Aktionen
// ---------------------------------------------------------------------
async function q(builder) {
  const { data, error } = await builder;
  if (error) throw error;
  return data;
}

const copyFields = it => ({
  product_id: it.product_id, best_before: it.best_before, expiry_kind: it.expiry_kind,
  estimated: it.estimated, opened_at: it.opened_at, frozen_at: it.frozen_at,
  added_at: it.added_at, added_by: it.added_by, compartment: it.compartment, location_id: it.location_id
});

function placementFields(it, loc) {
  const c = catOf(it.p);
  const f = { location_id: loc ? loc.id : null, compartment: null };
  const wasFrozen = it.loc && it.loc.kind === 'freezer';
  const toFreezer = loc && loc.kind === 'freezer';
  if (toFreezer && !wasFrozen) {
    f.frozen_at = todayISO();
    if (c.key !== 'tk') { f.best_before = addDays(c.freezer || 90); f.estimated = true; }
  } else if (wasFrozen && loc && !toFreezer) {
    f.frozen_at = null;
    f.best_before = addDays(c.thaw || 2);
    f.estimated = true;
  }
  return f;
}

const api = {
  async logEvent(it, action, qty, user) {
    await q(sb.from('events').insert({
      product_id: it.product_id, product_name: it.p.name, action, qty,
      location_name: it.loc ? it.loc.name : 'Einkaufswagen', user_email: user
    }));
  },
  async takeOut(it, n, action, user) {
    n = Math.min(n, it.qty);
    if (it.qty - n <= 0) await q(sb.from('stock').delete().eq('id', it.id));
    else await q(sb.from('stock').update({ qty: it.qty - n }).eq('id', it.id));
    await api.logEvent(it, action, n, user);
  },
  async setQty(it, qty) {
    if (qty < 1) return;
    await q(sb.from('stock').update({ qty }).eq('id', it.id));
  },
  async setDate(it, iso) {
    if (!iso) return;
    await q(sb.from('stock').update({ best_before: iso, estimated: false }).eq('id', it.id));
    // Lernen: Wie lange hält dieses Produkt bei euch wirklich?
    const frozen = (it.loc && it.loc.kind === 'freezer') || it.frozen_at || it.opened_at;
    if (it.estimated && !frozen) {
      const days = daysBetween(it.added_at, iso);
      if (days > 0 && days < 2000) {
        const p = it.p, n = p.learn_count || 0;
        const old = p.default_days || catOf(p).days;
        const next = Math.max(1, Math.round((old * n + days) / (n + 1)));
        await q(sb.from('products').update({ default_days: next, learn_count: n + 1 }).eq('id', p.id));
      }
    }
  },
  async toggleKind(it) {
    await q(sb.from('stock').update({ expiry_kind: it.expiry_kind === 'mhd' ? 'verbrauch' : 'mhd' }).eq('id', it.id));
  },
  async setCompartment(it, comp) {
    await q(sb.from('stock').update({ compartment: comp }).eq('id', it.id));
  },
  async markOpened(it) {
    const c = catOf(it.p);
    let bb = addDays(c.opened);
    if (it.best_before && it.best_before < bb) bb = it.best_before;
    const fields = { opened_at: todayISO(), best_before: bb, estimated: true };
    if (it.qty > 1) {
      await q(sb.from('stock').update({ qty: it.qty - 1 }).eq('id', it.id));
      const rows = await q(sb.from('stock').insert({ ...copyFields(it), ...fields, qty: 1 }).select('id'));
      return rows && rows[0] ? rows[0].id : null;
    }
    await q(sb.from('stock').update(fields).eq('id', it.id));
    return it.id;
  },
  async move(it, loc, n) {
    const pf = placementFields(it, loc);
    if (n >= it.qty) {
      await q(sb.from('stock').update(pf).eq('id', it.id));
    } else {
      await q(sb.from('stock').update({ qty: it.qty - n }).eq('id', it.id));
      await q(sb.from('stock').insert({ ...copyFields(it), ...pf, qty: n }));
    }
  },
  async split(it) {
    const n = Math.floor(it.qty / 2);
    if (n < 1) return;
    await q(sb.from('stock').update({ qty: it.qty - n }).eq('id', it.id));
    await q(sb.from('stock').insert({ ...copyFields(it), qty: n }));
  },
  async remove(ids) {
    if (ids.length) await q(sb.from('stock').delete().in('id', ids));
  },
  async createProduct(name, category) {
    const rows = await q(sb.from('products').insert({ name, category, default_days: CAT[category].days }).select());
    return rows[0];
  },
  async addTo(product, loc, items, user, qty = 1) {
    const existing = items.find(s => s.product_id === product.id && s.estimated && !s.opened_at
      && (loc ? s.location_id === loc.id : !s.location_id) && s.added_at === todayISO());
    if (existing) {
      await q(sb.from('stock').update({ qty: existing.qty + qty }).eq('id', existing.id));
      return existing.qty + qty;
    }
    const c = catOf(product);
    await q(sb.from('stock').insert({
      product_id: product.id, location_id: loc ? loc.id : null, qty,
      best_before: addDays(estimateDays(product, loc)), estimated: true,
      expiry_kind: c.verbrauch ? 'verbrauch' : 'mhd',
      frozen_at: loc && loc.kind === 'freezer' ? todayISO() : null,
      added_by: user
    }));
    return qty;
  },
  async saveLocation(loc, fields) {
    await q(sb.from('locations').update(fields).eq('id', loc.id));
  },
  async addLocation(sort) {
    await q(sb.from('locations').insert({ name: 'Neuer Lagerort', kind: 'shelf', sort }));
  },
  async deleteLocation(loc) {
    await q(sb.from('locations').delete().eq('id', loc.id));
  }
};

// ---------------------------------------------------------------------
// Kleine Bausteine
// ---------------------------------------------------------------------
const Icon = {
  back: () => html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 5 8 12 15 19"/></svg>`,
  chevron: () => html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 5 16 12 9 19"/></svg>`,
  search: () => html`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>`,
  gear: () => html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  cart: (c = '#2E7A4D') => html`<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke=${c} stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h3l2.4 11.2a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.5L21 7H6"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/></svg>`,
  trash: () => html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 7 20 7"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`,
  edit: () => html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`,
  barcode: () => html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 7V4h3M18 4h3v3M21 17v3h-3M6 20H3v-3"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/><line x1="17" y1="8" x2="17" y2="16"/></svg>`,
  camera: () => html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`,
  receipt: () => html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="12" x2="15" y2="12"/></svg>`,
  list: () => html`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/></svg>`,
  plate: (c = '#1E2B24', fill = '#E3F0E7') => html`<svg width="44" height="36" viewBox="0 0 44 36" aria-hidden="true"><line x1="4" y1="6" x2="4" y2="30" stroke=${c} stroke-width="2.2" stroke-linecap="round"/><path d="M2 6v7a2 2 0 0 0 4 0V6" fill="none" stroke=${c} stroke-width="1.8"/><circle cx="22" cy="18" r="14" fill="none" stroke=${c} stroke-width="2"/><circle cx="22" cy="18" r="8.5" fill=${fill} stroke=${c} stroke-width="1.6"/><path d="M40 6c-2.5 2-3 6-3 10h3v14" fill="none" stroke=${c} stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  folder: () => html`<svg width="40" height="36" viewBox="0 0 40 36" aria-hidden="true"><path d="M2 8a3 3 0 0 1 3-3h9l4 4h15a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3z" fill="#E3F0E7" stroke="#1E2B24" stroke-width="2" stroke-linejoin="round"/><circle cx="23" cy="19" r="6" fill="#FFFFFF" stroke="#1E2B24" stroke-width="2"/><line x1="27.5" y1="23.5" x2="33" y2="29" stroke="#1E2B24" stroke-width="2.6" stroke-linecap="round"/></svg>`
};

function LocationDrawing({ kind }) {
  const s = '#1E2B24';
  if (kind === 'freezer') return html`<svg width="44" height="58" viewBox="0 0 44 58" aria-hidden="true"><rect x="6" y="2" width="32" height="54" rx="5" fill="#D3E3F3" stroke=${s} stroke-width="2"/><line x1="6" y1="20" x2="38" y2="20" stroke=${s} stroke-width="2"/><line x1="6" y1="38" x2="38" y2="38" stroke=${s} stroke-width="2"/><line x1="17" y1="11" x2="27" y2="11" stroke=${s} stroke-width="2.6" stroke-linecap="round"/><line x1="17" y1="29" x2="27" y2="29" stroke=${s} stroke-width="2.6" stroke-linecap="round"/><line x1="17" y1="47" x2="27" y2="47" stroke=${s} stroke-width="2.6" stroke-linecap="round"/></svg>`;
  if (kind === 'pantry') return html`<svg width="48" height="58" viewBox="0 0 48 58" aria-hidden="true"><rect x="4" y="2" width="40" height="54" rx="4" fill="#F4E7D3" stroke=${s} stroke-width="2"/><line x1="4" y1="20" x2="44" y2="20" stroke=${s} stroke-width="2"/><line x1="4" y1="38" x2="44" y2="38" stroke=${s} stroke-width="2"/><rect x="10" y="9" width="8" height="11" rx="2" fill="#FFFFFF" stroke=${s} stroke-width="1.6"/><rect x="22" y="12" width="7" height="8" rx="2" fill="#E07A2E" stroke=${s} stroke-width="1.6"/><rect x="10" y="27" width="14" height="11" rx="1.5" fill="#FFFFFF" stroke=${s} stroke-width="1.6"/><rect x="28" y="29" width="8" height="9" rx="2" fill="#2E7A4D" stroke=${s} stroke-width="1.6"/><rect x="30" y="45" width="9" height="11" rx="2" fill="#FFFFFF" stroke=${s} stroke-width="1.6"/></svg>`;
  if (kind === 'shelf') return html`<svg width="48" height="58" viewBox="0 0 48 58" aria-hidden="true"><line x1="6" y1="2" x2="6" y2="56" stroke=${s} stroke-width="2.6" stroke-linecap="round"/><line x1="42" y1="2" x2="42" y2="56" stroke=${s} stroke-width="2.6" stroke-linecap="round"/><line x1="6" y1="20" x2="42" y2="20" stroke=${s} stroke-width="2.4"/><line x1="6" y1="38" x2="42" y2="38" stroke=${s} stroke-width="2.4"/><line x1="6" y1="54" x2="42" y2="54" stroke=${s} stroke-width="2.4"/><rect x="10" y="8" width="14" height="12" rx="1.5" fill="#F4E7D3" stroke=${s} stroke-width="1.6"/><rect x="27" y="11" width="10" height="9" rx="1.5" fill="#E4EEF5" stroke=${s} stroke-width="1.6"/><rect x="12" y="27" width="9" height="11" rx="2" fill="#FFFFFF" stroke=${s} stroke-width="1.6"/><rect x="24" y="27" width="14" height="11" rx="1.5" fill="#F4E7D3" stroke=${s} stroke-width="1.6"/><rect x="10" y="44" width="20" height="10" rx="1.5" fill="#E4EEF5" stroke=${s} stroke-width="1.6"/></svg>`;
  return html`<svg width="44" height="58" viewBox="0 0 44 58" aria-hidden="true"><rect x="6" y="2" width="32" height="54" rx="5" fill="#E4EEF5" stroke=${s} stroke-width="2"/><line x1="6" y1="19" x2="38" y2="19" stroke=${s} stroke-width="2"/><line x1="12" y1="8" x2="12" y2="13" stroke=${s} stroke-width="2.6" stroke-linecap="round"/><line x1="12" y1="25" x2="12" y2="36" stroke=${s} stroke-width="2.6" stroke-linecap="round"/></svg>`;
}

const Pill = ({ item }) => {
  const p = pillFor(item);
  return html`<span class=${'pill ' + p.tone}>${item.opened_at ? 'offen · ' : ''}${p.text}</span>`;
};
const Thumb = ({ product, size = 36 }) => html`<div class="thumb" style=${`width:${size}px;height:${size}px;background:${catOf(product).tint}`}>${(product.name || '?').charAt(0).toUpperCase()}</div>`;

function Header({ title, sub, onBack, right }) {
  return html`<header class="head">
    ${onBack && html`<button class="back" onClick=${onBack}>${Icon.back()} Start</button>`}
    <div class="head-row">
      <h1>${title}</h1>
      ${right}
    </div>
    ${sub && html`<div class="sub">${sub}</div>`}
  </header>`;
}

const sumQty = list => list.reduce((a, s) => a + s.qty, 0);

// ---------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------
function Login() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault();
    setBusy(true); setErr('');
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (error) setErr(error.message === 'Invalid login credentials' ? 'E-Mail oder Passwort stimmt nicht.' : error.message);
    setBusy(false);
  };
  return html`<main class="screen login">
    <div class="login-box">
      ${Icon.cart()}
      <h1>Unser Vorrat</h1>
      <p class="muted">Melde dich mit dem Konto an, das für dich angelegt wurde.</p>
      <form onSubmit=${submit} class="stack">
        <label class="field"><span>E-Mail</span>
          <input type="email" autocomplete="username" required value=${email} onInput=${e => setEmail(e.target.value)} />
        </label>
        <label class="field"><span>Passwort</span>
          <input type="password" autocomplete="current-password" required value=${pw} onInput=${e => setPw(e.target.value)} />
        </label>
        ${err && html`<div class="error" role="alert">${err}</div>`}
        <button class="btn primary" disabled=${busy}>${busy ? 'Anmelden …' : 'Anmelden'}</button>
      </form>
    </div>
  </main>`;
}

// ---------------------------------------------------------------------
// Startseite
// ---------------------------------------------------------------------
function Home({ ctx }) {
  const { locations, items, go, open, toast } = ctx;
  const [query, setQuery] = useState('');
  const placed = items.filter(s => s.loc);
  const cart = items.filter(s => !s.loc);
  const soon = placed.filter(isSoon).sort((a, b) => a.best_before.localeCompare(b.best_before));
  const now = new Date();
  const dateLabel = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  const tile = loc => {
    const here = placed.filter(s => s.location_id === loc.id);
    const n = sumQty(here);
    const bad = here.filter(isSoon).length;
    return html`<button class="tile" onClick=${() => go({ name: 'loc', id: loc.id })}>
      <div class="tile-top">
        <${LocationDrawing} kind=${loc.kind} />
        ${n === 0 ? html`<span class="pill grey">leer</span>`
          : bad ? html`<span class="pill red">${bad} bald ab</span>`
          : html`<span class="pill green">alles frisch</span>`}
      </div>
      <div class="tile-name">${loc.name}</div>
      <div class="tile-sub">${n} Artikel</div>
    </button>`;
  };

  const first = locations.slice(0, 2), rest = locations.slice(2);
  const ql = query.trim().toLowerCase();
  const results = ql ? ctx.products.filter(p => p.name.toLowerCase().includes(ql))
    .map(p => ({ p, rows: items.filter(s => s.product_id === p.id) }))
    .sort((a, b) => (b.rows.length > 0) - (a.rows.length > 0) || a.p.name.localeCompare(b.p.name))
    .slice(0, 20) : [];

  return html`<main class="screen home">
    <header class="head">
      <div class="sub">${dateLabel}</div>
      <div class="head-row">
        <h1>Unser Vorrat</h1>
        <button class="icon-btn" aria-label="Einstellungen" onClick=${() => go({ name: 'settings' })}>${Icon.gear()}</button>
      </div>
    </header>

    <label class="search">
      ${Icon.search()}
      <span class="sr">Vorrat durchsuchen</span>
      <input type="search" placeholder="Wo ist … z. B. Erdnussbutter" value=${query} onInput=${e => setQuery(e.target.value)} />
    </label>

    ${ql ? html`<section class="stack">
      ${results.length === 0 && html`<div class="card muted">Nichts gefunden.</div>`}
      ${results.map(({ p, rows }) => html`<div class="card result">
        <div class="result-name"><${Thumb} product=${p} size=${30} /> ${p.name}</div>
        ${rows.length === 0 ? html`<div class="muted small">Nicht im Vorrat.</div>`
          : rows.map(s => html`<button class="row-btn" onClick=${() => open(s.id)}>
              <span><b>${s.qty}×</b> ${s.loc ? s.loc.name : 'Einkaufswagen'}${s.compartment ? ' · ' + s.compartment : ''}</span>
              <${Pill} item=${s} />
            </button>`)}
      </div>`)}
    </section>` : html`
      ${soon.length > 0 && html`<section class="card alert">
        <div class="alert-head">
          <b>${soon.length === 1 ? '1 Sache läuft' : soon.length + ' Sachen laufen'} bald ab</b>
          <button class="link" onClick=${() => toast('Rezeptideen kommen in Phase 3.')}>Rezeptideen</button>
        </div>
        <div class="chips">
          ${soon.slice(0, 8).map(s => { const p = pillFor(s); return html`<button class=${'pill ' + p.tone} onClick=${() => open(s.id)}>${s.p.name} · ${p.text}</button>`; })}
        </div>
      </section>`}

      <div class="grid2">${first.map(tile)}</div>

      <button class="cart-tile" onClick=${() => go({ name: 'cart' })}>
        <div class="cart-icon">${Icon.cart()}${cart.length > 0 && html`<span class="badge">${cart.length}</span>`}</div>
        <div class="cart-text">
          <div class="cart-title">Wareneingang</div>
          <div class="cart-sub">${cart.length === 0 ? 'Einkauf erfassen' : cart.length + ' Artikel warten aufs Einräumen'}</div>
        </div>
        ${Icon.chevron()}
      </button>

      ${rest.length > 0 && html`<div class="grid2">${rest.map(tile)}</div>`}

      <div class="grid2">
        <button class="tile small" onClick=${() => go({ name: 'all' })}>
          ${Icon.folder()}
          <div><div class="tile-name">Gesamtbestand</div><div class="tile-sub">${sumQty(placed)} Artikel</div></div>
        </button>
        <button class="tile small plate-tile" onClick=${() => go({ name: 'plate' })}>
          ${Icon.plate()}
          <div><div class="tile-name">Teller</div><div class="tile-sub">heute ${ctx.todayConsumed} verbraucht</div></div>
        </button>
      </div>
    `}
  </main>`;
}

// ---------------------------------------------------------------------
// Lagerort (z. B. Kühlschrank geöffnet)
// ---------------------------------------------------------------------
function LocationView({ ctx, id }) {
  const loc = ctx.locations.find(l => l.id === id);
  if (!loc) return html`<main class="screen"><${Header} title="Lagerort nicht gefunden" onBack=${() => ctx.go({ name: 'home' })} /></main>`;
  const here = ctx.items.filter(s => s.location_id === id)
    .sort((a, b) => (a.best_before || '9999').localeCompare(b.best_before || '9999'));
  const groups = [];
  const comps = loc.compartments || [];
  comps.forEach(c => groups.push({ name: c, list: here.filter(s => s.compartment === c) }));
  const loose = here.filter(s => !s.compartment || !comps.includes(s.compartment));
  if (loose.length) groups.push({ name: comps.length ? 'Ohne Fach' : 'Inhalt', list: loose });
  const shown = groups.filter(g => g.list.length);
  const soon = here.filter(isSoon).length;
  const frame = loc.kind === 'pantry' || loc.kind === 'shelf' ? 'frame wood' : loc.kind === 'freezer' ? 'frame ice' : 'frame';

  return html`<main class="screen with-bar">
    <${Header} title=${loc.name} sub=${`${sumQty(here)} Artikel · ${soon} laufen bald ab`} onBack=${() => ctx.go({ name: 'home' })} />
    ${here.length === 0 ? html`<div class="card empty">
        <b>Hier ist noch nichts.</b>
        <span class="muted">Räum Artikel über den Wareneingang ein.</span>
        <button class="btn" onClick=${() => ctx.go({ name: 'cart' })}>Zum Wareneingang</button>
      </div>`
      : html`<div class=${frame}>
        ${shown.map(g => html`<section class="shelf">
          <div class="shelf-name">${g.name}</div>
          <div class="grid2 tight">
            ${g.list.map(s => html`<button class="item" onClick=${() => ctx.open(s.id)}>
              <${Thumb} product=${s.p} />
              <div class="item-text">
                <div class="item-name">${s.qty > 1 ? s.qty + '× ' : ''}${s.p.name}</div>
                <${Pill} item=${s} />
              </div>
            </button>`)}
          </div>
        </section>`)}
      </div>`}
    <div class="bottom-bar">
      <div class="plate-hint">${Icon.plate()}<div><b>Teller</b><div class="muted small">Produkt antippen → „Auf den Teller" = verbraucht</div></div></div>
    </div>
  </main>`;
}

// ---------------------------------------------------------------------
// Wareneingang / Einkaufswagen
// ---------------------------------------------------------------------
function AddBox({ ctx }) {
  const [text, setText] = useState('');
  const [newCat, setNewCat] = useState(false);
  const inputRef = useRef(null);
  const t = text.trim();
  const tl = t.toLowerCase();
  const matches = tl ? ctx.products.filter(p => p.name.toLowerCase().includes(tl))
    .sort((a, b) => (b.name.toLowerCase().startsWith(tl)) - (a.name.toLowerCase().startsWith(tl)) || a.name.localeCompare(b.name))
    .slice(0, 6) : [];
  const exact = ctx.products.some(p => p.name.toLowerCase() === tl);

  const add = ctx.act(async p => {
    const n = await api.addTo(p, null, ctx.items, ctx.user);
    ctx.toast(`${p.name} · ${n}× im Einkaufswagen`);
    setText(''); setNewCat(false);
    if (inputRef.current) inputRef.current.focus();
  });
  const create = ctx.act(async cat => {
    const p = await api.createProduct(t, cat);
    const n = await api.addTo(p, null, ctx.items, ctx.user);
    ctx.toast(`${p.name} angelegt · ${n}× im Einkaufswagen`);
    setText(''); setNewCat(false);
  });

  return html`<div class="card addbox">
    <label class="search inset">
      ${Icon.search()}
      <span class="sr">Artikel hinzufügen</span>
      <input ref=${inputRef} type="text" placeholder="Artikel hinzufügen, z. B. Milch" value=${text}
        onInput=${e => { setText(e.target.value); setNewCat(false); }} />
    </label>
    ${matches.length > 0 && html`<div class="suggest">
      ${matches.map(p => html`<button class="suggest-btn" onClick=${() => add(p)}><${Thumb} product=${p} size=${26} /> ${p.name} <span class="plus">+1</span></button>`)}
    </div>`}
    ${t.length >= 2 && !exact && !newCat && html`<button class="link pad" onClick=${() => setNewCat(true)}>„${t}" neu anlegen</button>`}
    ${newCat && html`<div class="stack">
      <div class="small muted">Welche Kategorie hat „${t}"? Danach schätzt die App die Haltbarkeit.</div>
      <div class="chips">${CATS.map(c => html`<button class="chip" style=${`background:${c.tint}`} onClick=${() => create(c.key)}>${c.name}</button>`)}</div>
    </div>`}
  </div>`;
}

function CartView({ ctx }) {
  const cart = ctx.items.filter(s => !s.loc).sort((a, b) => a.p.name.localeCompare(b.p.name));
  const [sel, setSel] = useState({});
  const selected = cart.filter(s => sel[s.id]);
  const allChecked = cart.length > 0 && selected.length === cart.length;
  const toggle = id => setSel(prev => { const n = { ...prev }; if (n[id]) delete n[id]; else n[id] = true; return n; });
  const toggleAll = () => setSel(allChecked ? {} : Object.fromEntries(cart.map(s => [s.id, true])));

  const store = ctx.act(async loc => {
    for (const s of selected) await api.move(s, loc, s.qty);
    ctx.toast(`${selected.length} Artikel → ${loc.name}`);
    setSel({});
  });
  const trash = ctx.act(async () => {
    await api.remove(selected.map(s => s.id));
    ctx.toast(`${selected.length} Artikel entfernt`);
    setSel({});
  });
  const soonFeature = what => ctx.toast(`${what} kommt in ${what === 'Einkaufsliste' || what === 'Barcode-Scan' ? 'Phase 2' : 'Phase 3'}.`);

  return html`<main class=${'screen' + (selected.length ? ' with-panel' : '')}>
    <${Header} title="Wareneingang" sub=${cart.length + ' Artikel im Einkaufswagen'} onBack=${() => ctx.go({ name: 'home' })} />
    <div class="grid4">
      <button class="src" onClick=${() => soonFeature('Barcode-Scan')}>${Icon.barcode()}Barcode</button>
      <button class="src" onClick=${() => soonFeature('Fotoerkennung')}>${Icon.camera()}Foto</button>
      <button class="src" onClick=${() => soonFeature('Kassenbon-Scan')}>${Icon.receipt()}Kassenbon</button>
      <button class="src" onClick=${() => soonFeature('Einkaufsliste')}>${Icon.list()}Liste</button>
    </div>
    <${AddBox} ctx=${ctx} />
    ${cart.length > 0 && html`<div class="row-between">
      <label class="check-all"><input type="checkbox" checked=${allChecked} onChange=${toggleAll} /> Alle auswählen</label>
      <span class="small muted">≈ = geschätzt</span>
    </div>`}
    <div class="stack">
      ${cart.map(s => html`<div class=${'cart-row' + (sel[s.id] ? ' on' : '')}>
        <label class="cart-check">
          <input type="checkbox" checked=${!!sel[s.id]} onChange=${() => toggle(s.id)} />
          <div class="cart-row-text">
            <div class="item-name">${s.p.name}</div>
            <div class="small muted">${s.qty}× · ${s.expiry_kind === 'verbrauch' ? 'zu verbrauchen bis' : 'MHD'} ${s.best_before ? (s.estimated ? '≈ ' : '') + fmtDate(s.best_before) : '–'}</div>
          </div>
        </label>
        <button class="icon-btn" aria-label=${'Details zu ' + s.p.name} onClick=${() => ctx.open(s.id)}>${Icon.edit()}</button>
      </div>`)}
      ${cart.length === 0 && html`<div class="card empty"><b>Der Einkaufswagen ist leer.</b><span class="muted">Oben Artikel eintippen, dann hier auswählen und einräumen.</span></div>`}
    </div>
    ${selected.length > 0 && html`<div class="panel">
      <div class="panel-title">${selected.length} ausgewählt · einlagern in</div>
      <div class="grid2 tight">
        ${ctx.locations.map(l => html`<button class="btn soft" onClick=${() => store(l)}>${l.name}</button>`)}
        <button class="btn danger" onClick=${trash}>${Icon.trash()} Müll</button>
      </div>
    </div>`}
  </main>`;
}

// ---------------------------------------------------------------------
// Gesamtbestand
// ---------------------------------------------------------------------
function AllView({ ctx }) {
  const [query, setQuery] = useState('');
  const ql = query.trim().toLowerCase();
  const byProduct = new Map();
  ctx.items.forEach(s => { if (!byProduct.has(s.product_id)) byProduct.set(s.product_id, []); byProduct.get(s.product_id).push(s); });
  let list = ctx.products.filter(p => ql ? p.name.toLowerCase().includes(ql) : byProduct.has(p.id))
    .map(p => ({ p, rows: byProduct.get(p.id) || [] }))
    .sort((a, b) => (b.rows.length > 0) - (a.rows.length > 0) || a.p.name.localeCompare(b.p.name));

  const minus = ctx.act(async s => { await api.takeOut(s, 1, 'consumed', ctx.user); ctx.toast(`1× ${s.p.name} auf dem Teller`); });
  const plus = ctx.act(async s => { await api.setQty(s, s.qty + 1); });
  const toCart = ctx.act(async p => { await api.addTo(p, null, ctx.items, ctx.user); ctx.toast(`${p.name} → Einkaufswagen`); });

  return html`<main class="screen">
    <${Header} title="Gesamtbestand" sub=${`${sumQty(ctx.items.filter(s => s.loc))} Artikel an ${ctx.locations.length} Orten`} onBack=${() => ctx.go({ name: 'home' })} />
    <label class="search">
      ${Icon.search()}<span class="sr">Bestand durchsuchen</span>
      <input type="search" placeholder="Suchen, z. B. Milch" value=${query} onInput=${e => setQuery(e.target.value)} />
    </label>
    <div class="stack">
      ${list.length === 0 && html`<div class="card muted">${ql ? 'Nichts gefunden.' : 'Noch nichts im Vorrat.'}</div>`}
      ${list.map(({ p, rows }) => html`<div class="card product">
        <div class="product-head">
          <${Thumb} product=${p} />
          <div class="grow"><div class="item-name">${p.name}</div><div class="small muted">${catOf(p).name}</div></div>
          <div class="total">${sumQty(rows)}</div>
        </div>
        ${rows.length === 0 ? html`<div class="row-between"><span class="muted small">Nicht vorrätig</span><button class="btn soft slim" onClick=${() => toCart(p)}>+ Wareneingang</button></div>`
          : rows.map(s => html`<div class="stock-row">
            <button class="row-btn grow" onClick=${() => ctx.open(s.id)}>
              <span><b>${s.qty}×</b> ${s.loc ? s.loc.name : 'Einkaufswagen'}${s.compartment ? ' · ' + s.compartment : ''}</span>
              <${Pill} item=${s} />
            </button>
            <button class="step" aria-label="1 verbraucht" onClick=${() => minus(s)}>−</button>
            <button class="step" aria-label="1 mehr" onClick=${() => plus(s)}>+</button>
          </div>`)}
      </div>`)}
    </div>
  </main>`;
}

// ---------------------------------------------------------------------
// Teller: Verlauf & Statistik
// ---------------------------------------------------------------------
function PlateView({ ctx }) {
  const ev = ctx.events;
  const monthStart = toISO(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const month = ev.filter(e => e.created_at.slice(0, 10) >= monthStart);
  const used = month.filter(e => e.action === 'consumed').reduce((a, e) => a + e.qty, 0);
  const tossed = month.filter(e => e.action === 'discarded').reduce((a, e) => a + e.qty, 0);
  const rate = used + tossed ? Math.round(used / (used + tossed) * 100) : null;
  const groups = [];
  ev.forEach(e => {
    const d = new Date(e.created_at); const key = toISO(d);
    let g = groups.find(x => x.key === key);
    if (!g) { g = { key, list: [] }; groups.push(g); }
    g.list.push(e);
  });
  const label = key => key === todayISO() ? 'Heute' : key === addDays(-1) ? 'Gestern' : fromISO(key).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  return html`<main class="screen">
    <${Header} title="Teller" sub="Was wurde verbraucht – und was nicht?" onBack=${() => ctx.go({ name: 'home' })} />
    <div class="grid3">
      <div class="stat"><div class="stat-num">${used}</div><div class="small muted">verbraucht diesen Monat</div></div>
      <div class="stat"><div class="stat-num">${tossed}</div><div class="small muted">weggeworfen</div></div>
      <div class="stat"><div class="stat-num">${rate === null ? '–' : rate + ' %'}</div><div class="small muted">gerettet</div></div>
    </div>
    <div class="stack">
      ${groups.length === 0 && html`<div class="card muted">Noch nichts auf dem Teller.</div>`}
      ${groups.map(g => html`<section class="stack">
        <div class="shelf-name">${label(g.key)}</div>
        <div class="card list">
          ${g.list.map(e => html`<div class="ev">
            <span class=${'dot ' + (e.action === 'consumed' ? 'green' : 'red')}></span>
            <div class="grow"><b>${e.qty}× ${e.product_name}</b><div class="small muted">${e.action === 'consumed' ? 'verbraucht' : 'weggeworfen'} · ${e.location_name || ''}${e.user_email ? ' · ' + e.user_email.split('@')[0] : ''}</div></div>
            <span class="small muted">${new Date(e.created_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>`)}
        </div>
      </section>`)}
    </div>
  </main>`;
}

// ---------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------
function LocationEditor({ ctx, loc, index }) {
  const [name, setName] = useState(loc.name);
  const [comps, setComps] = useState((loc.compartments || []).join(', '));
  useEffect(() => { setName(loc.name); setComps((loc.compartments || []).join(', ')); }, [loc.name, (loc.compartments || []).join('|')]);
  const save = ctx.act(async fields => { await api.saveLocation(loc, fields); });
  const reorder = ctx.act(async dir => {
    const list = ctx.locations.slice();
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    [list[index], list[j]] = [list[j], list[index]];
    for (let i = 0; i < list.length; i++) {
      if (list[i].sort !== i + 1) await api.saveLocation(list[i], { sort: i + 1 });
    }
  });
  const del = ctx.act(async () => {
    if (!confirm(`„${loc.name}" löschen? Alles, was dort liegt, wandert zurück in den Einkaufswagen.`)) return;
    await api.deleteLocation(loc);
    ctx.toast(`${loc.name} gelöscht`);
  });
  return html`<div class="card stack">
    <label class="field"><span>Name</span>
      <input value=${name} onInput=${e => setName(e.target.value)} onBlur=${() => name.trim() && name !== loc.name && save({ name: name.trim() })} />
    </label>
    <label class="field"><span>Art</span>
      <select value=${loc.kind} onChange=${e => save({ kind: e.target.value })}>
        ${KINDS.map(k => html`<option value=${k.key}>${k.name}</option>`)}
      </select>
    </label>
    <label class="field"><span>Fächer (mit Komma getrennt)</span>
      <input value=${comps} placeholder="z. B. Oben, Mitte, Unten" onInput=${e => setComps(e.target.value)}
        onBlur=${() => save({ compartments: comps.split(',').map(x => x.trim()).filter(Boolean) })} />
    </label>
    <div class="row-between">
      <div class="row">
        <button class="btn soft slim" aria-label="Nach oben" disabled=${index === 0} onClick=${() => reorder(-1)}>↑</button>
        <button class="btn soft slim" aria-label="Nach unten" disabled=${index === ctx.locations.length - 1} onClick=${() => reorder(1)}>↓</button>
      </div>
      <button class="btn danger slim" onClick=${del}>${Icon.trash()} Löschen</button>
    </div>
  </div>`;
}

function SettingsView({ ctx }) {
  const add = ctx.act(async () => { await api.addLocation(ctx.locations.length + 1); });

  return html`<main class="screen">
    <${Header} title="Einstellungen" onBack=${() => ctx.go({ name: 'home' })} />
    <div class="card row-between">
      <div><div class="small muted">Angemeldet als</div><b>${ctx.user}</b></div>
      <button class="btn soft slim" onClick=${() => sb.auth.signOut()}>Abmelden</button>
    </div>
    <div class="shelf-name">Lagerorte</div>
    <div class="stack">
      ${ctx.locations.map((l, i) => html`<${LocationEditor} key=${l.id} ctx=${ctx} loc=${l} index=${i} />`)}
      <button class="btn soft" onClick=${add}>+ Lagerort hinzufügen</button>
    </div>
    <p class="small muted center">Vorrat · Version 1 (Phase 1)</p>
  </main>`;
}

// ---------------------------------------------------------------------
// Detail-Blatt für einen Artikel
// ---------------------------------------------------------------------
function ItemSheet({ ctx, id, close }) {
  const it = ctx.items.find(s => s.id === id);
  const [mode, setMode] = useState('main');
  const [n, setN] = useState(1);
  useEffect(() => { if (!it) close(); }, [it]);
  useEffect(() => { if (it) setN(it.qty); }, [mode]);
  if (!it) return null;
  const inCart = !it.loc;
  const comps = it.loc ? (it.loc.compartments || []) : [];

  const run = (fn, msg) => ctx.act(async () => { await fn(); if (msg) ctx.toast(msg); })();
  const quick = [[3, '+3 Tage'], [7, '+1 Woche'], [14, '+2 Wochen'], [30, '+1 Monat'], [90, '+3 Monate']];

  return html`<div class="sheet-backdrop" onClick=${e => e.target === e.currentTarget && close()}>
    <div class="sheet" role="dialog" aria-label=${it.p.name}>
      <div class="sheet-grip"></div>
      <div class="row">
        <${Thumb} product=${it.p} size=${44} />
        <div class="grow">
          <div class="sheet-title">${it.p.name}</div>
          <div class="small muted">${it.loc ? it.loc.name : 'Einkaufswagen'}${it.compartment ? ' · ' + it.compartment : ''}${it.frozen_at ? ' · eingefroren am ' + fmtDate(it.frozen_at) : ''}${it.opened_at ? ' · geöffnet am ' + fmtDate(it.opened_at) : ''}</div>
        </div>
        <button class="icon-btn" aria-label="Schließen" onClick=${close}>✕</button>
      </div>

      ${mode === 'move' ? html`<div class="stack">
        <div class="row-between"><b>Umlagern</b>
          ${it.qty > 1 && html`<div class="stepper">
            <button class="step" aria-label="weniger" onClick=${() => setN(Math.max(1, n - 1))}>−</button>
            <span>${n} von ${it.qty}</span>
            <button class="step" aria-label="mehr" onClick=${() => setN(Math.min(it.qty, n + 1))}>+</button>
          </div>`}
        </div>
        <div class="grid2 tight">
          ${ctx.locations.filter(l => l.id !== it.location_id).map(l => html`<button class="btn soft" onClick=${() => run(() => api.move(it, l, n), `${n}× ${it.p.name} → ${l.name}`).then(() => setMode('main'))}>${l.name}</button>`)}
        </div>
        <button class="btn" onClick=${() => setMode('main')}>Abbrechen</button>
      </div>` : html`<div class="stack">
        <div class="row-between">
          <span>Menge</span>
          <div class="stepper">
            <button class="step" aria-label="weniger" disabled=${it.qty <= 1} onClick=${() => run(() => api.setQty(it, it.qty - 1))}>−</button>
            <span><b>${it.qty}</b></span>
            <button class="step" aria-label="mehr" onClick=${() => run(() => api.setQty(it, it.qty + 1))}>+</button>
          </div>
        </div>

        <div class="stack tight">
          <div class="row-between">
            <button class="link" onClick=${() => run(() => api.toggleKind(it))}>${it.expiry_kind === 'verbrauch' ? 'Zu verbrauchen bis' : 'Mindestens haltbar bis'} ⇄</button>
            <${Pill} item=${it} />
          </div>
          <div class="row">
            <input class="date" type="date" value=${it.best_before || ''} aria-label="Datum" onChange=${e => run(() => api.setDate(it, e.target.value), 'Datum gespeichert')} />
            ${it.estimated && it.best_before && html`<button class="btn soft slim" onClick=${() => run(() => api.setDate(it, it.best_before), 'Datum bestätigt')}>Stimmt so</button>`}
          </div>
          <div class="chips">${quick.map(([d, l]) => html`<button class="chip" onClick=${() => run(() => api.setDate(it, addDays(d)))}>${l}</button>`)}</div>
          ${it.expiry_kind === 'mhd' && it.best_before && daysLeft(it.best_before) < 0 && html`<div class="hint">Mindestens haltbar heißt nicht „sofort schlecht“: anschauen, riechen, probieren.</div>`}
          ${it.expiry_kind === 'verbrauch' && it.best_before && daysLeft(it.best_before) < 0 && html`<div class="hint red">Verbrauchsdatum überschritten – bitte nicht mehr essen.</div>`}
        </div>

        ${comps.length > 0 && html`<div class="stack tight">
          <span class="small muted">Fach</span>
          <div class="chips">${comps.map(c => html`<button class=${'chip' + (it.compartment === c ? ' on' : '')} onClick=${() => run(() => api.setCompartment(it, it.compartment === c ? null : c))}>${c}</button>`)}</div>
        </div>`}

        ${inCart ? html`<div class="grid2 tight">
          <button class="btn soft" disabled=${it.qty < 2} onClick=${() => run(() => api.split(it), 'Aufgeteilt – jetzt getrennt einlagern')}>Aufteilen</button>
          <button class="btn danger" onClick=${() => run(() => api.remove([it.id]), `${it.p.name} entfernt`)}>${Icon.trash()} Entfernen</button>
        </div>` : html`<div class="stack tight">
          <button class="btn primary big" onClick=${() => run(() => api.takeOut(it, 1, 'consumed', ctx.user), `1× ${it.p.name} auf dem Teller · verbraucht`)}>
            ${Icon.plate('#FFFFFF', 'transparent')} Auf den Teller · verbraucht
          </button>
          ${it.qty > 1 && html`<button class="btn" onClick=${() => run(() => api.takeOut(it, it.qty, 'consumed', ctx.user), `${it.qty}× ${it.p.name} verbraucht`)}>Alle ${it.qty} verbraucht</button>`}
          <div class="grid3">
            <button class="btn amber" disabled=${!!it.opened_at} onClick=${() => run(() => api.markOpened(it), `${it.p.name} geöffnet · hält noch ca. ${catOf(it.p).opened} Tage`)}>Geöffnet</button>
            <button class="btn blue" onClick=${() => setMode('move')}>Umlagern</button>
            <button class="btn danger" onClick=${() => run(() => api.takeOut(it, 1, 'discarded', ctx.user), `1× ${it.p.name} als weggeworfen erfasst`)}>Weg­geworfen</button>
          </div>
        </div>`}
      </div>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------
// App-Rahmen
// ---------------------------------------------------------------------
function Main({ session }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [route, setRoute] = useState({ name: 'home' });
  const [sheet, setSheet] = useState(null);
  const [toastMsg, setToastMsg] = useState('');
  const toastTimer = useRef(null);
  const reloadTimer = useRef(null);
  const user = session.user.email;

  const reload = useCallback(async () => {
    try {
      const since = new Date(); since.setDate(since.getDate() - 62);
      const [locations, products, stock, events] = await Promise.all([
        q(sb.from('locations').select('*').order('sort').order('created_at')),
        q(sb.from('products').select('*').order('name')),
        q(sb.from('stock').select('*')),
        q(sb.from('events').select('*').gte('created_at', since.toISOString()).order('created_at', { ascending: false }).limit(500))
      ]);
      setData({ locations, products, stock, events });
      setError('');
    } catch (e) {
      setError(e.message || String(e));
    }
  }, []);

  const scheduleReload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(reload, 250);
  }, [reload]);

  useEffect(() => {
    reload();
    const ch = sb.channel('vorrat')
      .on('postgres_changes', { event: '*', schema: 'public' }, scheduleReload)
      .subscribe();
    const onVis = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { sb.removeChannel(ch); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  const toast = useCallback(msg => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(''), 2600);
  }, []);

  const go = useCallback(r => { setRoute(r); setSheet(null); window.scrollTo(0, 0); }, []);

  const ctx = useMemo(() => {
    if (!data) return null;
    const pmap = new Map(data.products.map(p => [p.id, p]));
    const lmap = new Map(data.locations.map(l => [l.id, l]));
    const items = data.stock.map(s => ({
      ...s,
      p: pmap.get(s.product_id) || { id: s.product_id, name: '?', category: 'sonstiges' },
      loc: s.location_id ? lmap.get(s.location_id) || null : null
    }));
    const t = todayISO();
    const todayConsumed = data.events.filter(e => e.action === 'consumed' && toISO(new Date(e.created_at)) === t).reduce((a, e) => a + e.qty, 0);
    return {
      ...data, items, todayConsumed, user, go, toast,
      open: id => setSheet({ id }),
      act: fn => async (...args) => {
        try { const r = await fn(...args); await reload(); return r; }
        catch (e) { toast('Fehler: ' + (e.message || e)); }
      }
    };
  }, [data, reload]);

  if (error && !data) return html`<main class="screen"><div class="card stack">
    <b>Verbindung fehlgeschlagen</b><span class="muted small">${error}</span>
    <button class="btn" onClick=${reload}>Nochmal versuchen</button>
    <button class="btn soft" onClick=${() => sb.auth.signOut()}>Abmelden</button>
  </div></main>`;
  if (!ctx) return html`<div class="splash">Lade Vorrat …</div>`;
  if (ctx.locations.length === 0) return html`<main class="screen"><div class="card stack">
    <b>Keine Lagerorte gefunden</b>
    <span class="muted small">Entweder wurde das Datenbank-Skript noch nicht ausgeführt, oder deine E-Mail-Adresse (${user}) steht noch nicht in der Tabelle „members".</span>
    <button class="btn" onClick=${reload}>Neu laden</button>
    <button class="btn soft" onClick=${() => sb.auth.signOut()}>Abmelden</button>
  </div></main>`;

  let view;
  if (route.name === 'loc') view = html`<${LocationView} ctx=${ctx} id=${route.id} />`;
  else if (route.name === 'cart') view = html`<${CartView} ctx=${ctx} />`;
  else if (route.name === 'all') view = html`<${AllView} ctx=${ctx} />`;
  else if (route.name === 'plate') view = html`<${PlateView} ctx=${ctx} />`;
  else if (route.name === 'settings') view = html`<${SettingsView} ctx=${ctx} />`;
  else view = html`<${Home} ctx=${ctx} />`;

  return html`${view}
    ${sheet && html`<${ItemSheet} key=${sheet.id} ctx=${ctx} id=${sheet.id} close=${() => setSheet(null)} />`}
    ${toastMsg && html`<div class="toast" role="status">${toastMsg}</div>`}`;
}

function App() {
  const [session, setSession] = useState(undefined);
  useEffect(() => {
    sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  if (session === undefined) return html`<div class="splash">Lade …</div>`;
  if (!session) return html`<${Login} />`;
  return html`<${Main} key=${session.user.id} session=${session} />`;
}

render(html`<${App} />`, document.getElementById('app'));
