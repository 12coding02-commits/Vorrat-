// =====================================================================
//  Barcode-Scanner: Kamera, Erkennung, Produktdatenbank (Open Food Facts)
// =====================================================================

// ---------- Codes prüfen ---------------------------------------------
export function normalizeCode(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 12 ? '0' + d : d;          // UPC-A → EAN-13
}

function ean13ok(c) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(c[i]) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === Number(c[12]);
}

export function validCode(c) {
  if (!/^\d+$/.test(c)) return false;
  if (c.length === 13) return ean13ok(c);
  return c.length === 8 || c.length === 14;
}

// ---------- Piepton ----------------------------------------------------
let audio = null;
export function primeAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch (e) { /* kein Ton möglich */ }
}
export function beep() {
  try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) { /* egal */ }
  try {
    if (!audio) return;
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 1150;
    g.gain.setValueAtTime(0.12, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.12);
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.13);
  } catch (e) { /* egal */ }
}

// ---------- Kamera & Erkennung ------------------------------------------
const CONSTRAINTS = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
};

export function cameraMessage(e) {
  const n = e && e.name;
  if (n === 'NoMediaDevices') return 'Dieser Browser erlaubt keinen Kamerazugriff. Bitte die App über Safari bzw. das Home-Bildschirm-Symbol öffnen.';
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Der Kamerazugriff wurde abgelehnt. iPhone: Einstellungen → Apps → Safari → Kamera → „Erlauben“. Danach die App neu öffnen.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Es wurde keine passende Kamera gefunden.';
  if (n === 'NotReadableError') return 'Die Kamera wird gerade von einer anderen App benutzt.';
  return 'Die Kamera konnte nicht gestartet werden' + (e && e.message ? ': ' + e.message : '.');
}

// Startet die Kamera im <video> und ruft onCode(rohwert) für jeden erkannten Code.
// Gibt { stop() } zurück.
export async function startScanner(video, onCode) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('no media'); err.name = 'NoMediaDevices'; throw err;
  }

  // 1) Eingebaute Erkennung (z. B. Android/Chrome)
  if ('BarcodeDetector' in window) {
    let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
    try {
      const sup = await window.BarcodeDetector.getSupportedFormats();
      formats = formats.filter(f => sup.includes(f));
    } catch (e) { formats = []; }
    if (formats.length) {
      const detector = new window.BarcodeDetector({ formats });
      const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
      video.srcObject = stream;
      await video.play().catch(() => {});
      let busy = false;
      const timer = setInterval(async () => {
        if (busy || video.readyState < 2) return;
        busy = true;
        try {
          const found = await detector.detect(video);
          if (found.length) onCode(found[0].rawValue);
        } catch (e) { /* nächster Versuch */ }
        busy = false;
      }, 180);
      return {
        stop() {
          clearInterval(timer);
          stream.getTracks().forEach(t => t.stop());
          video.srcObject = null;
        }
      };
    }
  }

  // 2) Sonst (iPhone/Safari): ZXing-Bibliothek, wird nur bei Bedarf geladen
  const { BrowserMultiFormatReader } = await import('https://esm.sh/@zxing/browser@0.1.5');
  const reader = new BrowserMultiFormatReader();
  const controls = await reader.decodeFromConstraints(CONSTRAINTS, video, result => {
    if (result) onCode(result.getText());
  });
  return { stop() { try { controls.stop(); } catch (e) { /* schon gestoppt */ } } };
}

// ---------- Open Food Facts ---------------------------------------------
export async function lookupOFF(code) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const fields = 'product_name,product_name_de,generic_name_de,brands,categories_tags,image_front_small_url,quantity';
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${fields}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status !== 1 || !j.product) return null;
    const p = j.product;
    return {
      name: (p.product_name_de || p.product_name || p.generic_name_de || '').trim(),
      brand: (p.brands || '').split(',')[0].trim(),
      quantity: (p.quantity || '').trim(),
      tags: Array.isArray(p.categories_tags) ? p.categories_tags : [],
      image: p.image_front_small_url || null
    };
  } catch (e) {
    return { error: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Kategorie & passenden Artikel erraten ------------------------
const CAT_RULES = [
  ['aufstrich', ['peanut-butter', 'nut-butter', 'hazelnut-spread', 'cocoa-and-hazelnuts', 'erdnussbutter', 'nuss-nougat']],
  ['tk',        ['frozen', 'tiefk']],
  ['konserve',  ['canned', 'konserv']],
  ['kaese',     ['cheese', 'käse', 'kaese']],
  ['milch',     ['milk', 'yogurt', 'yoghurt', 'dair', 'cream', 'butter', 'quark', 'milch', 'joghurt', 'sahne']],
  ['eier',      ['egg']],
  ['fisch',     ['fish', 'seafood', 'salmon', 'tuna']],
  ['fleisch',   ['meat', 'sausage', 'ham', 'salami', 'poultry', 'chicken', 'bacon', 'wurst', 'fleisch', 'schinken']],
  ['obst',      ['fruit', 'vegetable', 'salad', 'gemüse', 'obst']],
  ['brot',      ['bread', 'bakery', 'brioche', 'rolls', 'toast', 'brot']],
  ['trocken',   ['pasta', 'rice', 'cereal', 'flake', 'muesli', 'legume', 'noodle', 'nudel', 'reis']],
  ['aufstrich', ['spread', 'jam', 'honey', 'sauce', 'condiment', 'ketchup', 'mustard', 'mayonnaise', 'pesto']],
  ['backen',    ['flour', 'sugar', 'oil', 'baking', 'mehl', 'zucker']],
  ['getraenke', ['beverage', 'drink', 'juice', 'water', 'coffee', 'tea', 'saft', 'getränk']],
  ['suess',     ['snack', 'sweet', 'chocolate', 'candy', 'biscuit', 'cookie', 'chip', 'crisp', 'schoko', 'keks']]
];

export function guessCategory(info) {
  const tags = (info.tags || []).join(' ').toLowerCase();
  const name = (info.name || '').toLowerCase();
  for (const [cat, keys] of CAT_RULES) if (keys.some(k => tags.includes(k))) return cat;
  for (const [cat, keys] of CAT_RULES) if (keys.some(k => name.includes(k))) return cat;
  return 'sonstiges';
}

export function isLongLife(info) {
  const s = ((info.tags || []).join(' ') + ' ' + (info.name || '')).toLowerCase();
  return /uht|long-life|h-milch|haltbare milch/.test(s);
}

// Hinweise: Open-Food-Facts-Kategorie bzw. Name → Artikel aus dem Startkatalog
const HINTS = [
  ['uht', 'H-Milch'], ['long-life-milk', 'H-Milch'], ['h-milch', 'H-Milch'],
  ['fresh-milk', 'Frischmilch'], ['frische milch', 'Frischmilch'], ['vollmilch', 'Frischmilch'], ['fettarme milch', 'Frischmilch'],
  ['yogurt', 'Joghurt'], ['quark', 'Quark'], ['sour-cream', 'Schmand'], ['whipping-cream', 'Sahne'], ['cooking-cream', 'Sahne'],
  ['butters', 'Butter'], ['cream-cheese', 'Frischkäse'], ['gouda', 'Gouda'], ['mozzarella', 'Mozzarella'],
  ['parmigiano', 'Parmesan'], ['grana-padano', 'Parmesan'], ['feta', 'Feta'], ['eggs', 'Eier'],
  ['minced', 'Hackfleisch'], ['chicken-breast', 'Hähnchenbrust'], ['cooked-ham', 'Kochschinken'], ['salami', 'Salami'],
  ['bacon', 'Speck'], ['salmon', 'Lachs'], ['frozen-peas', 'TK-Erbsen'], ['frozen-pizza', 'TK-Pizza'],
  ['frozen-spinach', 'TK-Spinat'], ['fish-finger', 'Fischstäbchen'], ['ice-cream', 'Eiscreme'],
  ['spaghetti', 'Spaghetti'], ['rices', 'Reis'], ['oat-flake', 'Haferflocken'], ['rolled-oat', 'Haferflocken'],
  ['muesli', 'Müsli'], ['strained-tomato', 'Passierte Tomaten'], ['tomato-puree', 'Passierte Tomaten'],
  ['sweet-corn', 'Mais (Dose)'], ['kidney', 'Kidneybohnen'], ['tuna', 'Thunfisch (Dose)'], ['coconut-milk', 'Kokosmilch'],
  ['peanut-butter', 'Erdnussbutter'], ['jams', 'Marmelade'], ['hazelnut-spread', 'Nuss-Nougat-Creme'],
  ['cocoa-and-hazelnuts-spread', 'Nuss-Nougat-Creme'], ['pesto', 'Pesto'], ['ketchup', 'Ketchup'], ['mustard', 'Senf'],
  ['mayonnaise', 'Mayonnaise'], ['wheat-flour', 'Mehl'], ['sugars', 'Zucker'], ['olive-oil', 'Olivenöl'],
  ['orange-juice', 'Orangensaft'], ['mineral-water', 'Mineralwasser'], ['chocolate', 'Schokolade'],
  ['crisps', 'Chips'], ['chips', 'Chips'], ['sandwich-bread', 'Toastbrot'], ['toast', 'Toastbrot']
];

export function guessExisting(info, products) {
  const tags = (info.tags || []).join(' ').toLowerCase();
  const text = (tags + ' ' + (info.name || '')).toLowerCase();
  const name = ((info.name || '') + ' ' + (info.brand || '')).toLowerCase();
  const byName = new Map(products.map(p => [p.name.toLowerCase(), p]));
  const out = [];
  const add = p => { if (p && !out.includes(p)) out.push(p); };
  for (const [key, pname] of HINTS) if (text.includes(key)) add(byName.get(pname.toLowerCase()));
  for (const p of products) {
    const n = p.name.toLowerCase();
    if (n.length >= 4 && name.includes(n)) add(p);
  }
  return out.slice(0, 3);
}
