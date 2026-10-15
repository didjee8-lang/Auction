/** Оценка по скрину — OCR + цены аукциона + своя комиссия */
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
  try {
    if (Array.isArray(window.rows)) return window.rows;
  } catch {}
  try {
    if (typeof rows !== "undefined" && Array.isArray(rows)) return rows;
  } catch {}
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

let scCatalog = []; // {id, name, nameN}
let scCatalogAt = 0;
let scLines = []; // {id, name, qty, unit, manual}
let scState = (() => {
  try {
    return JSON.parse(localStorage.getItem(SCAN_LS) || "{}") || {};
  } catch {
    return {};
  }
})();
scState = Object.assign({ commissionType: "pct", commission: "5", lastText: "" }, scState);

function scSave() {
  try {
    localStorage.setItem(SCAN_LS, JSON.stringify({
      commissionType: scState.commissionType,
      commission: scState.commission,
    }));
  } catch {}
}

async function scEnsureCatalog() {
  if (scCatalog.length > 100 && Date.now() - scCatalogAt < 120000) return;
  const map = new Map();
  for (const r of scGetRows()) {
    const id = scBaseId(r.id);
    if (!id || !r.name) continue;
    if (!map.has(id)) map.set(id, { id, name: r.name, nameN: scNorm(r.name) });
  }
  try {
    const res = await fetch("/api/items?q=", { cache: "no-store" });
    // API without q returns 500 items - better search with empty not ideal
  } catch {}
  // also try common empty load - fetch items with broad query letters
  const letters = "абвгдежзиклмнопрстуфхцчшщэюя".split("");
  for (const L of letters.slice(0, 8)) {
    try {
      const res = await fetch(`/api/items?q=${encodeURIComponent(L)}`, { cache: "no-store" });
      if (!res.ok) continue;
      const j = await res.json();
      for (const row of j.rows || []) {
        const id = scBaseId(row.id);
        if (!id || !row.name) continue;
        if (!map.has(id)) map.set(id, { id, name: row.name, nameN: scNorm(row.name) });
      }
    } catch {}
  }
  // from hideout recipes if loaded
  try {
    const r = await fetch("/hideout_recipes.json", { cache: "force-cache" });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j)) {
        for (const rec of j) {
          if (rec.result?.id && rec.result?.name) {
            const id = scBaseId(rec.result.id);
            if (!map.has(id)) map.set(id, { id, name: rec.result.name, nameN: scNorm(rec.result.name) });
          }
          for (const ing of rec.ingredients || []) {
            if (ing.id && ing.name) {
              const id = scBaseId(ing.id);
              if (!map.has(id)) map.set(id, { id, name: ing.name, nameN: scNorm(ing.name) });
            }
          }
        }
      }
    }
  } catch {}
  scCatalog = [...map.values()].sort((a, b) => b.name.length - a.name.length);
  scCatalogAt = Date.now();
}

function scScore(queryN, nameN) {
  if (!queryN || !nameN) return 0;
  if (nameN === queryN) return 100;
  if (nameN.includes(queryN) || queryN.includes(nameN)) return 80 + Math.min(15, Math.min(queryN.length, nameN.length));
  const qw = queryN.split(" ").filter((w) => w.length > 2);
  const nw = nameN.split(" ").filter((w) => w.length > 2);
  if (!qw.length || !nw.length) return 0;
  let hit = 0;
  for (const w of qw) if (nw.some((x) => x.includes(w) || w.includes(x))) hit++;
  return (hit / qw.length) * 70;
}

function scMatchLine(textLine) {
  const raw = textLine.trim();
  if (raw.length < 3) return null;
  // qty patterns: "12x Name", "12× Name", "Name x12", "Name 12 шт"
  let qty = 1;
  let namePart = raw;
  let m =
    raw.match(/^(\d+)\s*[x×*]\s*(.+)$/i) ||
    raw.match(/^(.+?)\s*[x×*]\s*(\d+)\s*$/i) ||
    raw.match(/^(\d+)\s+(.+)$/) ||
    raw.match(/^(.+?)\s+(\d+)\s*(шт|pcs)?\.?$/i);
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
  if (qn.length < 3) return null;

  let best = null;
  let bestScore = 0;
  for (const it of scCatalog) {
    const sc = scScore(qn, it.nameN);
    if (sc > bestScore) {
      bestScore = sc;
      best = it;
    }
  }
  if (!best || bestScore < 45) return null;
  const pr = scPrice(best.id);
  return {
    id: best.id,
    name: best.name,
    qty,
    unit: pr.price,
    score: bestScore,
    manual: false,
  };
}

function scParseText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const found = [];
  const seen = new Set();
  for (const line of lines) {
    const hit = scMatchLine(line);
    if (!hit) continue;
    const key = hit.id + "|" + hit.qty;
    if (seen.has(hit.id)) {
      // merge qty
      const ex = found.find((x) => x.id === hit.id);
      if (ex) ex.qty += hit.qty;
      continue;
    }
    seen.add(hit.id);
    found.push(hit);
  }
  return found;
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

async function scOcrImage(fileOrUrl) {
  const T = await scLoadTesseract();
  const st = document.getElementById("scStatus");
  const worker = await T.createWorker("rus+eng", 1, {
    logger: (m) => {
      if (!st) return;
      if (m.status === "recognizing text") st.textContent = `Распознавание… ${Math.round((m.progress || 0) * 100)}%`;
      else st.textContent = m.status || "OCR…";
    },
  });
  try {
    const { data } = await worker.recognize(fileOrUrl);
    return data?.text || "";
  } finally {
    await worker.terminate();
  }
}

function scCommissionValue(gross) {
  const raw = String(scState.commission || "0").replace(/\s/g, "").replace(",", ".");
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (scState.commissionType === "fix") return Math.min(gross, n);
  // percent
  return Math.round(gross * (Math.min(100, n) / 100));
}

function scTotals() {
  let gross = 0;
  let missing = 0;
  for (const L of scLines) {
    const unit = L.unit != null ? Number(L.unit) : scPrice(L.id).price;
    L.unit = unit;
    if (unit == null || !Number.isFinite(unit)) {
      missing++;
      continue;
    }
    gross += unit * Math.max(1, Number(L.qty) || 1);
  }
  const fee = scCommissionValue(gross);
  const net = Math.max(0, gross - fee);
  return { gross, fee, net, missing };
}

function scRender() {
  const box = document.getElementById("scList");
  const sumBox = document.getElementById("scSummary");
  if (!box) return;

  if (!scLines.length) {
    box.innerHTML = `<div class="empty">Загрузите скрин или добавьте предметы вручную</div>`;
  } else {
    box.innerHTML = scLines
      .map((L, i) => {
        const sum = L.unit != null ? L.unit * Math.max(1, L.qty || 1) : null;
        return `<div class="sc-line" data-i="${i}">
          <div class="sc-line-main">
            <div class="sc-ico"><img src="/api/icon/${encodeURIComponent(scBaseId(L.id))}" alt="" onerror="this.style.display='none'"></div>
            <div class="sc-meta">
              <div class="sc-name">${scEsc(L.name)}</div>
              <div class="sub">${scEsc(L.id)}${L.score ? " · совпадение " + Math.round(L.score) + "%" : ""}</div>
            </div>
          </div>
          <div class="sc-fields">
            <label>Кол-во <input data-f="qty" data-i="${i}" type="text" inputmode="numeric" value="${L.qty || 1}"></label>
            <label>Цена/шт <input data-f="unit" data-i="${i}" type="text" inputmode="decimal" value="${L.unit != null ? L.unit : ""}" placeholder="нет"></label>
            <div class="sc-sum">${scFmt(sum)}</div>
            <button type="button" class="btn sc-del" data-del="${i}">✕</button>
          </div>
        </div>`;
      })
      .join("");

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
      btn.onclick = () => {
        scLines.splice(Number(btn.dataset.del), 1);
        scRender();
      };
    });
  }

  const t = scTotals();
  if (sumBox) {
    sumBox.innerHTML = `
      <div class="row"><span>Сумма предметов (рынок)</span><b>${scFmt(t.gross)}</b></div>
      <div class="row sub"><span>Ваша комиссия / запас</span><b>− ${scFmt(t.fee)}</b></div>
      <div class="row sc-pay"><span>К отправке</span><b class="pos">${scFmt(t.net)}</b></div>
      ${t.missing ? `<div class="sub">Без цены: ${t.missing} поз. — укажите цену вручную</div>` : ""}
      <button type="button" class="btn primary" id="scCopyPay" style="margin-top:8px">Скопировать сумму</button>
    `;
    const copy = document.getElementById("scCopyPay");
    if (copy) {
      copy.onclick = async () => {
        const n = Math.round(t.net);
        try {
          await navigator.clipboard.writeText(String(n));
          copy.textContent = "Скопировано: " + n.toLocaleString("ru-RU");
          setTimeout(() => (copy.textContent = "Скопировать сумму"), 1500);
        } catch {
          prompt("Скопируйте сумму", String(n));
        }
      };
    }
  }
}

async function scRunFile(file) {
  const st = document.getElementById("scStatus");
  const prev = document.getElementById("scPreview");
  if (prev && file) {
    const url = URL.createObjectURL(file);
    prev.innerHTML = `<img src="${url}" alt="screenshot">`;
  }
  if (st) st.textContent = "Каталог предметов…";
  await scEnsureCatalog();
  if (st) st.textContent = "OCR…";
  let text = "";
  try {
    text = await scOcrImage(file);
  } catch (e) {
    if (st) st.textContent = "OCR ошибка: " + (e.message || e);
    return;
  }
  scState.lastText = text;
  const ta = document.getElementById("scText");
  if (ta) ta.value = text;
  if (st) st.textContent = "Сопоставление с каталогом…";
  scLines = scParseText(text);
  // refresh prices
  for (const L of scLines) {
    if (!L.manual) L.unit = scPrice(L.id).price;
  }
  if (st) st.textContent = scLines.length ? `Найдено: ${scLines.length}` : "Ничего не распознано — правьте текст или добавьте вручную";
  scRender();
}

function scFromTextarea() {
  const ta = document.getElementById("scText");
  const text = ta?.value || "";
  scLines = scParseText(text);
  for (const L of scLines) {
    if (!L.manual) L.unit = scPrice(L.id).price;
  }
  const st = document.getElementById("scStatus");
  if (st) st.textContent = scLines.length ? `Найдено: ${scLines.length}` : "Нет совпадений";
  scRender();
}

async function scAddManual() {
  const q = document.getElementById("scAddQ")?.value?.trim();
  if (!q) return;
  await scEnsureCatalog();
  const qn = scNorm(q);
  let best = null, bestScore = 0;
  for (const it of scCatalog) {
    const sc = scScore(qn, it.nameN);
    if (sc > bestScore) { bestScore = sc; best = it; }
  }
  if (!best || bestScore < 40) {
    alert("Не найден в каталоге: " + q);
    return;
  }
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
  if (file) {
    file.addEventListener("change", () => {
      const f = file.files && file.files[0];
      if (f) scRunFile(f);
    });
  }
  const drop = document.getElementById("scDrop");
  if (drop) {
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const f = e.dataTransfer?.files?.[0];
      if (f) scRunFile(f);
    });
    drop.addEventListener("click", () => file?.click());
  }

  document.getElementById("scParseText")?.addEventListener("click", scFromTextarea);
  document.getElementById("scAddBtn")?.addEventListener("click", () => scAddManual());
  document.getElementById("scAddQ")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      scAddManual();
    }
  });
  document.getElementById("scClear")?.addEventListener("click", () => {
    scLines = [];
    scRender();
  });

  const type = document.getElementById("scCommType");
  const comm = document.getElementById("scComm");
  if (type) {
    type.value = scState.commissionType || "pct";
    type.onchange = () => {
      scState.commissionType = type.value;
      scSave();
      scRender();
    };
  }
  if (comm) {
    comm.value = scState.commission ?? "5";
    comm.oninput = () => {
      scState.commission = comm.value;
      scSave();
      scRender();
    };
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
