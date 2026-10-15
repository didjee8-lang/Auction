/** Оценка по скрину — сетка иконок + OCR количества + цены аукциона */
const SCAN_LS = "sz_scan_v1";

function scEsc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function scFmt(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("ru-RU") + " ₽";
}
function scBaseId(id) {
  return String(id || "").replace(/@q\d+(?:p\d+)?$/, "");
}
function scNorm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»""']/g, "")
    .replace(/[^a-zа-я0-9\s.\-x×]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function scGetRows() {
  try { if (Array.isArray(window.rows)) return window.rows; } catch {}
  try { if (typeof rows !== "undefined" && Array.isArray(rows)) return rows; } catch {}
  return [];
}
function scPrice(id) {
  const base = scBaseId(id);
  let best = null;
  let sales = 0;
  for (const r of scGetRows()) {
    if (scBaseId(r.id) !== base) continue;
    for (const p of [r.minUnitPrice, r.min_price, r.minPrice, r.lastSale]) {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0 && (best == null || n < best)) best = n;
    }
    const s = Number(r.soldPerDay || r.sales7d || 0) || 0;
    if (s > sales) sales = s;
  }
  return { price: best, sales };
}

/* ---- catalog + icon hashes ---- */
let scCatalog = []; // {id, name, nameN, hash}
let scCatalogAt = 0;
let scHashReady = false;
let scLines = [];
let scState = (() => {
  try { return JSON.parse(localStorage.getItem(SCAN_LS) || "{}") || {}; } catch { return {}; }
})();
scState = Object.assign({ commissionType: "pct", commission: "5" }, scState);

function scSave() {
  try {
    localStorage.setItem(SCAN_LS, JSON.stringify({
      commissionType: scState.commissionType,
      commission: scState.commission,
    }));
  } catch {}
}

/** Average hash 16x16 → 256-bit as hex string */
function scAHashFromImageData(data, w, h) {
  const N = 16;
  const vals = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const x0 = Math.floor((x * w) / N);
      const x1 = Math.floor(((x + 1) * w) / N);
      const y0 = Math.floor((y * h) / N);
      const y1 = Math.floor(((y + 1) * h) / N);
      let sum = 0, cnt = 0;
      for (let py = y0; py < Math.max(y0 + 1, y1); py++) {
        for (let px = x0; px < Math.max(x0 + 1, x1); px++) {
          const i = (py * w + px) * 4;
          const a = data[i + 3];
          if (a < 20) continue;
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          cnt++;
        }
      }
      vals[y * N + x] = cnt ? sum / cnt : 0;
    }
  }
  let avg = 0;
  for (let i = 0; i < vals.length; i++) avg += vals[i];
  avg /= vals.length || 1;
  const bits = [];
  for (let i = 0; i < vals.length; i++) bits.push(vals[i] >= avg ? 1 : 0);
  let out = "";
  for (let i = 0; i < bits.length; i += 4) {
    const v = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    out += v.toString(16);
  }
  return out;
}

/** Dominant colors bucket signature (12 dims) for rejecting wrong matches */
function scColorSigFromImageData(data, w, h) {
  const bins = new Float64Array(12); // 4 hue-ish groups x 3 brightness via RGB coarse
  let n = 0;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 32));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 30) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const yv = 0.299 * r + 0.587 * g + 0.114 * b;
      if (yv < 18) continue; // ignore near-black bg
      n++;
      // coarse color family
      let fam = 0;
      if (r >= g && r >= b) fam = 0; // red-ish
      else if (g >= r && g >= b) fam = 1; // green
      else fam = 2; // blue
      if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20) fam = 3; // gray
      const br = yv < 80 ? 0 : yv < 160 ? 1 : 2;
      bins[fam * 3 + br] += 1;
    }
  }
  if (n > 0) for (let i = 0; i < bins.length; i++) bins[i] /= n;
  return Array.from(bins);
}

function scColorDist(a, b) {
  if (!a || !b || a.length !== b.length) return 99;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

function scHamming(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return d;
}

function scHashCanvas(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  if (w < 4 || h < 4) return null;
  const img = ctx.getImageData(0, 0, w, h);
  return {
    hash: scAHashFromImageData(img.data, w, h),
    color: scColorSigFromImageData(img.data, w, h),
  };
}

async function scLoadIconHash(id) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        const size = 64;
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, size, size);
        const scale = Math.min(size / img.width, size / img.height) * 0.92;
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
        resolve(scHashCanvas(c));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = `/api/icon/${encodeURIComponent(id)}?t=1`;
  });
}

async function scEnsureCatalog(onProgress) {
  // Только крафт из рецептов; приоритет — начальные дешёвые ингредиенты
  if (scCatalog.length > 20 && scHashReady && Date.now() - scCatalogAt < 300000) return;

  const map = new Map();
  const recipeUrls = ["/hideout_recipes.json", "/api/hideout/recipes", "/assets/hideout_recipes.json"];
  let recipes = [];
  for (const url of recipeUrls) {
    try {
      const r = await fetch(url, { cache: "force-cache" });
      if (!r.ok) continue;
      const text = await r.text();
      if (text.trimStart().startsWith("<")) continue;
      const j = JSON.parse(text);
      if (Array.isArray(j) && j.length) { recipes = j; break; }
    } catch {}
  }

  // min skill / energy per item from recipes where it is an ingredient
  const meta = new Map(); // id -> {minSkill, minEnergy, asIng, asRes}

  for (const rec of recipes) {
    let minSkill = 99;
    const perks = rec.perks || {};
    for (const v of Object.values(perks)) {
      const n = Number(v);
      if (Number.isFinite(n) && n < minSkill) minSkill = n;
    }
    if (minSkill === 99) minSkill = 5;
    const energy = Number(rec.energy) || 0;

    if (rec.result?.id) {
      const id = scBaseId(rec.result.id);
      if (id) {
        if (!map.has(id)) {
          map.set(id, {
            id,
            name: rec.result.name || id,
            nameN: scNorm(rec.result.name || id),
            hash: null,
            color: null,
            role: "result",
            minSkill: 99,
            minEnergy: 1e9,
            priority: 50,
          });
        }
        const m = meta.get(id) || { minSkill: 99, minEnergy: 1e9, asIng: 0, asRes: 0 };
        m.asRes++;
        meta.set(id, m);
      }
    }
    for (const ing of rec.ingredients || []) {
      if (!ing?.id) continue;
      const id = scBaseId(ing.id);
      if (!id) continue;
      const prev = map.get(id);
      if (prev) {
        if (prev.role === "result") prev.role = "both";
        else if (prev.role !== "both") prev.role = "ingredient";
        if (ing.name) {
          prev.name = ing.name;
          prev.nameN = scNorm(ing.name);
        }
        prev.minSkill = Math.min(prev.minSkill ?? 99, minSkill);
        prev.minEnergy = Math.min(prev.minEnergy ?? 1e9, energy || 0);
      } else {
        map.set(id, {
          id,
          name: ing.name || id,
          nameN: scNorm(ing.name || id),
          hash: null,
          color: null,
          role: "ingredient",
          minSkill,
          minEnergy: energy || 0,
          priority: 0,
        });
      }
      const m = meta.get(id) || { minSkill: 99, minEnergy: 1e9, asIng: 0, asRes: 0 };
      m.asIng++;
      m.minSkill = Math.min(m.minSkill, minSkill);
      m.minEnergy = Math.min(m.minEnergy, energy || 0);
      meta.set(id, m);
    }
  }

  // priority: ingredient + low skill + low energy first (starter craft mats)
  for (const it of map.values()) {
    const m = meta.get(it.id);
    if (m) {
      it.minSkill = Math.min(it.minSkill ?? 99, m.minSkill);
      it.minEnergy = Math.min(it.minEnergy ?? 1e9, m.minEnergy);
    }
    let prio = 100;
    if (it.role === "ingredient" || it.role === "both") prio -= 40;
    if ((it.minSkill ?? 99) <= 1) prio -= 25;
    else if ((it.minSkill ?? 99) <= 2) prio -= 15;
    else if ((it.minSkill ?? 99) <= 3) prio -= 8;
    if ((it.minEnergy ?? 1e9) <= 500) prio -= 10;
    else if ((it.minEnergy ?? 1e9) <= 1500) prio -= 5;
    // market price if known — cheaper = higher priority
    const pr = scPrice(it.id).price;
    it.marketPrice = pr;
    if (pr != null) {
      if (pr <= 500) prio -= 20;
      else if (pr <= 2000) prio -= 12;
      else if (pr <= 10000) prio -= 6;
      else if (pr >= 100000) prio += 10; // expensive less preferred on ties
    }
    it.priority = prio;
  }

  for (const r of scGetRows()) {
    const id = scBaseId(r.id);
    if (!map.has(id)) continue;
    const it = map.get(id);
    if (r.name) {
      it.name = r.name;
      it.nameN = scNorm(r.name);
    }
    const pr = scPrice(id).price;
    if (pr != null) it.marketPrice = pr;
  }

  // sort: high priority first for matching preference when distances close
  scCatalog = [...map.values()].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

  const need = scCatalog.filter((x) => !x.hash);
  let done = 0;
  const concurrency = 10;
  for (let i = 0; i < need.length; i += concurrency) {
    const batch = need.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (it) => {
        const sig = await scLoadIconHash(it.id);
        if (sig) {
          it.hash = sig.hash;
          it.color = sig.color;
        }
        done++;
        if (onProgress) onProgress(done, need.length);
      })
    );
  }
  scHashReady = true;
  scCatalogAt = Date.now();
}

/**
 * Match icon: strict hash + color, prefer starter/cheap ingredients on close scores
 */
function scMatchHash(sig) {
  if (!sig || !sig.hash || !scCatalog.length) return null;
  const candidates = [];
  for (const it of scCatalog) {
    if (!it.hash) continue;
    const hd = scHamming(sig.hash, it.hash);
    const cd = scColorDist(sig.color, it.color);
    // Deliberately do not let price/recipe priority influence visual identity.
    // A wrong item with a plausible price is worse than asking for confirmation.
    const score = hd + cd * 34;
    candidates.push({ item: it, hd, cd, score });
  }
  candidates.sort((a, b) => a.score - b.score);
  if (!candidates.length) return null;
  const best = candidates[0];
  const second = candidates[1];
  // Conservative rejection: icon hashes are not semantic AI. Similar-looking
  // icons must not silently become a false item in a price calculation.
  if (best.hd > 24 || best.cd > 0.38) return null;
  if (second && (second.score - best.score) < 5.5 && second.hd <= best.hd + 5) return null;
  const confidence = Math.max(0, Math.min(99, Math.round(100 - best.hd * 2.4 - best.cd * 32)));
  if (confidence < 42) return null;
  return { item: best.item, dist: best.hd, colorDist: best.cd, score: confidence };
}

/* ---- grid detection on screenshot ---- */
function scLoadFileToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не удалось открыть изображение"));
    };
    img.src = url;
  });
}

function scLuma(data, i) {
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

/** Find inventory-like cells: bright content on dark bg in a grid */
function scDetectCells(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  const TH = 28; // non-background

  // activity map downsampled
  const step = Math.max(2, Math.floor(Math.min(w, h) / 200));
  const cols = Math.ceil(w / step);
  const rows = Math.ceil(h / step);
  const act = new Uint8Array(cols * rows);
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (scLuma(data, i) > TH) act[Math.floor(y / step) * cols + Math.floor(x / step)] = 1;
    }
  }

  // find bounding content
  let minX = cols, minY = rows, maxX = 0, maxY = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!act[y * cols + x]) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX <= minX || maxY <= minY) return [];

  // estimate cell size by projection peaks
  const projX = new Float64Array(cols);
  const projY = new Float64Array(rows);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (act[y * cols + x]) {
        projX[x]++;
        projY[y]++;
      }
    }
  }

  function clusterGaps(proj, a, b) {
    // find runs of activity → cell centers in downsampled coords
    const runs = [];
    let i = a;
    while (i <= b) {
      while (i <= b && proj[i] < 1) i++;
      if (i > b) break;
      let j = i;
      while (j <= b && proj[j] >= 1) j++;
      runs.push({ a: i, b: j - 1, mid: (i + j - 1) / 2 });
      i = j;
    }
    return runs;
  }

  let xRuns = clusterGaps(projX, minX, maxX);
  let yRuns = clusterGaps(projY, minY, maxY);

  // if too few runs, try uniform grid by median gap
  if (xRuns.length < 2 || yRuns.length < 1) {
    // fallback: assume ~7 cols like screenshot
    const bw = (maxX - minX + 1) * step;
    const bh = (maxY - minY + 1) * step;
    const guessCols = Math.max(1, Math.round(bw / (bh / Math.max(1, Math.round(bh / (bw / 7))))));
    const nCol = Math.min(12, Math.max(3, guessCols || 7));
    const nRow = Math.min(8, Math.max(1, Math.round((nCol * bh) / bw)));
    const cells = [];
    const ox = minX * step;
    const oy = minY * step;
    const cw = bw / nCol;
    const ch = bh / nRow;
    for (let ry = 0; ry < nRow; ry++) {
      for (let cx = 0; cx < nCol; cx++) {
        cells.push({
          x: Math.round(ox + cx * cw),
          y: Math.round(oy + ry * ch),
          w: Math.round(cw),
          h: Math.round(ch),
        });
      }
    }
    return cells;
  }

  // merge thin noise runs
  function mergeRuns(runs, minSpan) {
    const out = [];
    for (const r of runs) {
      if (out.length && r.a - out[out.length - 1].b <= 2) {
        out[out.length - 1].b = r.b;
        out[out.length - 1].mid = (out[out.length - 1].a + out[out.length - 1].b) / 2;
      } else if (r.b - r.a >= minSpan) {
        out.push({ ...r });
      }
    }
    return out.length ? out : runs;
  }
  xRuns = mergeRuns(xRuns, 1);
  yRuns = mergeRuns(yRuns, 1);

  const cells = [];
  for (const yr of yRuns) {
    for (const xr of xRuns) {
      const x = xr.a * step;
      const y = yr.a * step;
      const cw = Math.max(8, (xr.b - xr.a + 1) * step);
      const ch = Math.max(8, (yr.b - yr.a + 1) * step);
      // skip nearly empty
      let bright = 0, tot = 0;
      for (let py = y; py < y + ch; py += 2) {
        for (let px = x; px < x + cw; px += 2) {
          if (px >= w || py >= h) continue;
          tot++;
          if (scLuma(data, (py * w + px) * 4) > TH) bright++;
        }
      }
      if (tot && bright / tot < 0.02) continue;
      cells.push({ x, y, w: cw, h: ch });
    }
  }
  return cells;
}

function scCropHash(canvas, cell) {
  // icon is upper ~70% of cell; ignore margins and qty text
  const pad = Math.floor(Math.min(cell.w, cell.h) * 0.1);
  const iw = Math.max(8, cell.w - pad * 2);
  const ih = Math.max(8, Math.floor(cell.h * 0.68) - pad);
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, 0, 64, 64);
  ctx.drawImage(canvas, cell.x + pad, cell.y + pad, iw, ih, 4, 4, 56, 56);
  return scHashCanvas(c);
}

function scCropQtyCanvas(canvas, cell) {
  const pad = Math.floor(Math.min(cell.w, cell.h) * 0.05);
  const y0 = cell.y + Math.floor(cell.h * 0.68);
  const h = Math.max(10, cell.h - Math.floor(cell.h * 0.68) - 2);
  const c = document.createElement("canvas");
  c.width = Math.max(20, cell.w - pad * 2);
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(canvas, cell.x + pad, y0, cell.w - pad * 2, h, 0, 0, c.width, c.height);
  // boost contrast for OCR
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = y > 90 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function scOcrQty(canvas) {
  try {
    const T = await scLoadTesseract();
    const { data } = await T.recognize(canvas, "eng", {
      tessedit_char_whitelist: "xX×0123456789",
    });
    const t = (data?.text || "").replace(/\s/g, "");
    const m = t.match(/[x×X]?(\d{1,4})/);
    if (m) return Math.max(1, parseInt(m[1], 10) || 1);
  } catch {}
  return 1;
}

let scTesseract = null;
async function scLoadTesseract() {
  if (scTesseract) return scTesseract;
  if (window.Tesseract) {
    scTesseract = window.Tesseract;
    return scTesseract;
  }
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  scTesseract = window.Tesseract;
  return scTesseract;
}

async function scRecognizeScreenshot(file, st) {
  if (st) st.textContent = "Открытие изображения…";
  const canvas = await scLoadFileToCanvas(file);
  if (st) st.textContent = "Индекс иконок крафта…";
  await scEnsureCatalog((done, total) => {
    if (st) st.textContent = `Иконки крафта ${done}/${total}…`;
  });

  if (st) st.textContent = "Поиск ячеек сетки…";
  let cells = scDetectCells(canvas);
  // filter oversized/undersized
  if (cells.length) {
    const areas = cells.map((c) => c.w * c.h).sort((a, b) => a - b);
    const med = areas[Math.floor(areas.length / 2)] || 1;
    cells = cells.filter((c) => {
      const a = c.w * c.h;
      return a > med * 0.35 && a < med * 2.8;
    });
  }

  if (st) st.textContent = `Ячеек: ${cells.length}. Распознавание…`;
  const found = [];
  const seen = new Map();

  // limit parallel qty OCR
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (st) st.textContent = `Предмет ${i + 1}/${cells.length}…`;
    const hash = scCropHash(canvas, cell);
    const match = scMatchHash(hash);
    if (!match) continue;
    const qtyCanvas = scCropQtyCanvas(canvas, cell);
    let qty = 1;
    try {
      qty = await scOcrQty(qtyCanvas);
    } catch {
      qty = 1;
    }
    const id = match.item.id;
    if (seen.has(id)) {
      seen.get(id).qty += qty;
    } else {
      const row = {
        id,
        name: match.item.name,
        qty,
        unit: scPrice(id).price,
        score: match.score,
        dist: match.dist,
        itemRole: match.item.role === "ingredient" ? "ингредиент" : match.item.role === "both" ? "крафт" : "результат",
        manual: false,
      };
      seen.set(id, row);
      found.push(row);
    }
  }

  // fallback: full-image OCR text match if almost nothing found
  if (found.length < 1) {
    if (st) st.textContent = "Мало совпадений — пробуем OCR текста…";
    try {
      const T = await scLoadTesseract();
      const { data } = await T.recognize(canvas, "rus+eng");
      const text = data?.text || "";
      const ta = document.getElementById("scText");
      if (ta) ta.value = text;
      const fromText = scParseTextFallback(text);
      for (const row of fromText) {
        if (!seen.has(row.id)) {
          seen.set(row.id, row);
          found.push(row);
        }
      }
    } catch {}
  }

  // показать сначала начальные/дешёвые ингредиенты
  found.sort((a, b) => {
    const ia = scCatalog.find((x) => x.id === a.id);
    const ib = scCatalog.find((x) => x.id === b.id);
    return (ia?.priority ?? 50) - (ib?.priority ?? 50);
  });
  return found;
}

function scScoreName(queryN, nameN) {
  if (!queryN || !nameN) return 0;
  if (nameN === queryN) return 100;
  if (nameN.includes(queryN) || queryN.includes(nameN)) return 85;
  const qw = queryN.split(" ").filter((w) => w.length > 2);
  const nw = nameN.split(" ").filter((w) => w.length > 2);
  if (!qw.length) return 0;
  let hit = 0;
  for (const w of qw) if (nw.some((x) => x.includes(w) || w.includes(x))) hit++;
  return (hit / qw.length) * 70;
}

function scParseTextFallback(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const raw of lines) {
    let qty = 1;
    let namePart = raw;
    const m =
      raw.match(/^(\d+)\s*[x×*]\s*(.+)$/i) ||
      raw.match(/^(.+?)\s*[x×*]\s*(\d+)\s*$/i) ||
      raw.match(/^([x×])\s*(\d+)\s*(.*)$/i);
    if (m) {
      if (/^\d+$/.test(m[1])) {
        qty = Math.max(1, parseInt(m[1], 10) || 1);
        namePart = m[2];
      } else if (/^\d+$/.test(m[2])) {
        qty = Math.max(1, parseInt(m[2], 10) || 1);
        namePart = m[1];
      }
    }
    const qn = scNorm(namePart);
    if (qn.length < 3) continue;
    let best = null, bestScore = 0;
    for (const it of scCatalog) {
      const sc = scScoreName(qn, it.nameN);
      if (sc > bestScore) { bestScore = sc; best = it; }
    }
    if (!best || bestScore < 50) continue;
    out.push({ id: best.id, name: best.name, qty, unit: scPrice(best.id).price, score: bestScore, manual: false });
  }
  return out;
}

function scCommissionValue(gross) {
  const raw = String(scState.commission || "0").replace(/\s/g, "").replace(",", ".");
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (scState.commissionType === "fix") return Math.min(gross, n);
  return Math.round(gross * (Math.min(100, n) / 100));
}

function scTotals() {
  let gross = 0, missing = 0;
  for (const L of scLines) {
    const unit = L.unit != null ? Number(L.unit) : scPrice(L.id).price;
    L.unit = unit;
    if (unit == null || !Number.isFinite(unit)) { missing++; continue; }
    gross += unit * Math.max(1, Number(L.qty) || 1);
  }
  const fee = scCommissionValue(gross);
  return { gross, fee, net: Math.max(0, gross - fee), missing };
}

function scRender() {
  const box = document.getElementById("scList");
  const sumBox = document.getElementById("scSummary");
  if (!box) return;
  if (!scLines.length) {
    box.innerHTML = `<div class="empty">Загрузите скрин инвентаря (иконки + xN)</div>`;
  } else {
    box.innerHTML = scLines.map((L, i) => {
      const sum = L.unit != null ? L.unit * Math.max(1, L.qty || 1) : null;
      return `<div class="sc-line" data-i="${i}">
        <div class="sc-line-main">
          <div class="sc-ico"><img src="/api/icon/${encodeURIComponent(scBaseId(L.id))}" alt="" onerror="this.style.display='none'"></div>
          <div class="sc-meta">
            <div class="sc-name">${scEsc(L.name)}</div>
            <div class="sub">${scEsc(L.id)}${L.score != null ? " · совп. " + L.score + "%" : ""}${L.itemRole ? " · " + L.itemRole : ""}</div>
          </div>
        </div>
        <div class="sc-fields">
          <label>Кол-во <input data-f="qty" data-i="${i}" type="text" inputmode="numeric" value="${L.qty || 1}"></label>
          <label>Цена/шт <input data-f="unit" data-i="${i}" type="text" inputmode="decimal" value="${L.unit != null ? L.unit : ""}" placeholder="нет"></label>
          <div class="sc-sum">${scFmt(sum)}</div>
          <button type="button" class="btn sc-del" data-del="${i}">✕</button>
        </div>
      </div>`;
    }).join("");

    box.querySelectorAll("input[data-f]").forEach((inp) => {
      inp.oninput = () => {
        const i = Number(inp.dataset.i);
        const f = inp.dataset.f;
        if (!scLines[i]) return;
        if (f === "qty") scLines[i].qty = Math.max(1, Math.floor(Number(String(inp.value).replace(/\s/g, "")) || 1));
        if (f === "unit") {
          const v = String(inp.value).replace(/\s/g, "").replace(",", ".");
          scLines[i].unit = v === "" ? null : Number(v);
          scLines[i].manual = true;
        }
        scRender();
      };
    });
    box.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = () => { scLines.splice(Number(btn.dataset.del), 1); scRender(); };
    });
  }

  const t = scTotals();
  if (sumBox) {
    sumBox.innerHTML = `
      <div class="row"><span>Сумма предметов (рынок)</span><b>${scFmt(t.gross)}</b></div>
      <div class="row sub"><span>Ваша комиссия / запас</span><b>− ${scFmt(t.fee)}</b></div>
      <div class="row sc-pay"><span>К отправке</span><b class="pos">${scFmt(t.net)}</b></div>
      ${t.missing ? `<div class="sub">Без цены: ${t.missing} — укажите вручную</div>` : ""}
      <div class="sc-copy-actions">
        <button type="button" class="btn primary" id="scCopyPay">Скопировать сумму</button>
        <button type="button" class="btn" id="scCopyItems">Скопировать список предметов и цен</button>
      </div>`;
    document.getElementById("scCopyItems")?.addEventListener("click", async () => {
      const lines = scLines.map((L) => {
        const qty = Math.max(1, Number(L.qty) || 1);
        const unit = L.unit != null && Number.isFinite(Number(L.unit)) ? Number(L.unit) : null;
        const total = unit == null ? "цена не найдена" : `${Math.round(unit * qty)} ₽`;
        return `${L.name} ×${qty} | ${unit == null ? "—" : `${Math.round(unit)} ₽/шт`} | ${total}`;
      });
      const payload = lines.join("\n") + `\nИтого после комиссии: ${Math.round(t.net)} ₽`;
      try { await navigator.clipboard.writeText(payload); const b = document.getElementById("scCopyItems"); if (b) { b.textContent = "Список скопирован"; setTimeout(() => { if (b.isConnected) b.textContent = "Скопировать список предметов и цен"; }, 1200); } }
      catch { prompt("Список предметов", payload); }
    });
    document.getElementById("scCopyPay")?.addEventListener("click", async () => {
      const n = Math.round(t.net);
      try {
        await navigator.clipboard.writeText(String(n));
        const b = document.getElementById("scCopyPay");
        if (b) { b.textContent = "Скопировано"; setTimeout(() => (b.textContent = "Скопировать сумму"), 1200); }
      } catch { prompt("Сумма", String(n)); }
    });
  }
}

async function scRunFile(file) {
  const st = document.getElementById("scStatus");
  const prev = document.getElementById("scPreview");
  if (prev && file) {
    const url = URL.createObjectURL(file);
    prev.innerHTML = `<img src="${url}" alt="screenshot">`;
  }
  try {
    scLines = await scRecognizeScreenshot(file, st);
    if (st) st.textContent = scLines.length
      ? `Надёжно распознано: ${scLines.length} · каталог крафта: ${scCatalog.length}. Сомнительные совпадения пропущены, добавьте их вручную.`
      : `Не найдено в крафте (${scCatalog.length} предм.) — добавьте вручную`;
  } catch (e) {
    if (st) st.textContent = "Ошибка: " + (e.message || e);
    scLines = [];
  }
  scRender();
}

async function scAddManual() {
  const q = document.getElementById("scAddQ")?.value?.trim();
  if (!q) return;
  await scEnsureCatalog();
  const qn = scNorm(q);
  let best = null, bestScore = 0;
  for (const it of scCatalog) {
    const sc = scScoreName(qn, it.nameN);
    if (sc > bestScore) { bestScore = sc; best = it; }
  }
  if (!best || bestScore < 40) { alert("Не найден: " + q); return; }
  const pr = scPrice(best.id);
  const exist = scLines.find((x) => x.id === best.id);
  if (exist) exist.qty += 1;
  else scLines.push({ id: best.id, name: best.name, qty: 1, unit: pr.price, score: bestScore, manual: false });
  document.getElementById("scAddQ").value = "";
  scRender();
}

function scBind() {
  if (window._scBound) return;
  window._scBound = true;
  const file = document.getElementById("scFile");
  file?.addEventListener("change", () => {
    const f = file.files && file.files[0];
    if (f) scRunFile(f);
  });
  const drop = document.getElementById("scDrop");
  if (drop) {
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const f = e.dataTransfer?.files?.[0];
      if (f) scRunFile(f);
    });
    drop.addEventListener("click", () => file?.click());
  }
  document.getElementById("scParseText")?.addEventListener("click", async () => {
    const ta = document.getElementById("scText");
    await scEnsureCatalog();
    scLines = scParseTextFallback(ta?.value || "");
    scRender();
  });
  document.getElementById("scAddBtn")?.addEventListener("click", () => scAddManual());
  document.getElementById("scAddQ")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); scAddManual(); }
  });
  document.getElementById("scClear")?.addEventListener("click", () => { scLines = []; scRender(); });
  const type = document.getElementById("scCommType");
  const comm = document.getElementById("scComm");
  if (type) {
    type.value = scState.commissionType || "pct";
    type.onchange = () => { scState.commissionType = type.value; scSave(); scRender(); };
  }
  if (comm) {
    comm.value = scState.commission ?? "5";
    comm.oninput = () => { scState.commission = comm.value; scSave(); scRender(); };
  }
}

function renderScan() {
  scBind();
  const type = document.getElementById("scCommType");
  const comm = document.getElementById("scComm");
  if (type) type.value = scState.commissionType || "pct";
  if (comm) comm.value = scState.commission ?? "5";
  scRender();
}

window.renderScan = renderScan;
window.scBind = scBind;
