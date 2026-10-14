/** Убежище — калькулятор крафта (таблица как stalfarm /crafts) */
const HO_FEE = 0.05;
const HO_LS = "sz_hideout_v1";

function hoEsc(str){
  return String(str??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function esc(str){ return hoEsc(str); }
function hoGetRows(){
  if(typeof window!=="undefined" && Array.isArray(window.rows)) return window.rows;
  if(typeof rows!=="undefined" && Array.isArray(rows)) return rows;
  return [];
}

let hoRecipes = [];
let hoLoaded = false;
let hoState = (() => {
  try { return JSON.parse(localStorage.getItem(HO_LS) || "{}"); } catch { return {}; }
})();
if (!hoState || typeof hoState !== "object") hoState = {};
hoState = Object.assign({
  q: "", hasItem: "", bench: "", cat: "", sort: "profit",
  minProfit: 0, minRoi: 0, budget: "",
  crafts: {}, stock: {}, manualPrice: {}, selected: null,
}, hoState);

function hoSave() {
  try { localStorage.setItem(HO_LS, JSON.stringify(hoState)); } catch {}
}

function hoPrice(itemId) {
  if (hoState.manualPrice[itemId] != null && hoState.manualPrice[itemId] !== "") {
    const n = Number(String(hoState.manualPrice[itemId]).replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(n) && n >= 0) return { price: n, source: "manual" };
  }
  const marketRows = hoGetRows();
  const base = String(itemId);
  let best = null;
  let sales = 0;
  for (const r of marketRows) {
    const id = String(r.id || "").replace(/@q\d+(?:p\d+)?$/, "");
    if (id !== base) continue;
    const candidates = [r.minUnitPrice, r.min_price, r.minPrice, r.lastSale, r.refPrice, r.marketPrice, r.price];
    for (const p of candidates) {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0 && (best == null || n < best)) best = n;
    }
    const s = Number(r.sales7d || r.soldPerDay || r.salesToday || r.liquidity || 0) || 0;
    if (s > sales) sales = s;
  }
  if (best != null) return { price: best, source: "market", sales };
  return { price: null, source: "none", sales: 0 };
}

function hoCalc(recipe, craftCount) {
  const n = Math.max(1, Math.floor(Number(craftCount) || 1));
  const ings = recipe.ingredients || [];
  const resAmt = (recipe.result && recipe.result.amount) || 1;
  const outId = recipe.result && recipe.result.id;
  const sellInfo = outId ? hoPrice(outId) : { price: null, source: "none", sales: 0 };
  const sellUnit = sellInfo.price;

  let matCost = 0, buyCost = 0, missingLines = 0;
  const lines = [];
  for (const ing of ings) {
    const need = (Number(ing.amount) || 0) * n;
    const own = Math.max(0, Number(hoState.stock[ing.id]) || 0);
    const toBuy = Math.max(0, need - own);
    const pi = hoPrice(ing.id);
    const unit = pi.price;
    const lineMat = unit != null ? unit * need : null;
    const lineBuy = unit != null ? unit * toBuy : null;
    if (lineMat != null) matCost += lineMat; else missingLines++;
    if (lineBuy != null) buyCost += lineBuy;
    lines.push({ id: ing.id, name: ing.name, need, own, toBuy, unit, source: pi.source, lineMat, lineBuy });
  }

  const outQty = resAmt * n;
  const gross = sellUnit != null ? sellUnit * outQty : null;
  const fee = gross != null ? Math.round(gross * HO_FEE) : null;
  const netRevenue = gross != null ? gross - fee : null;
  const profitCash = netRevenue != null && missingLines === 0 ? Math.round(netRevenue - buyCost) : null;
  const profitFull = netRevenue != null && missingLines === 0 ? Math.round(netRevenue - matCost) : null;
  const roi = profitCash != null && buyCost > 0 ? Math.round((profitCash / buyCost) * 1000) / 10
    : (profitCash != null && buyCost === 0 && profitCash > 0 ? Infinity : null);
  const breakEven = (outQty > 0 && missingLines === 0)
    ? Math.ceil((buyCost / outQty) / (1 - HO_FEE)) : null;

  let status = "nodata";
  if (missingLines > 0 || sellUnit == null) status = "nodata";
  else if (profitCash != null && profitCash > 0) status = "good";
  else if (profitCash != null && profitCash === 0) status = "edge";
  else if (profitCash != null && profitCash < 0) status = "bad";

  return {
    n, outQty, lines, matCost, buyCost, missingLines,
    sellUnit, sellSource: sellInfo.source, sales: sellInfo.sales || 0,
    gross, fee, netRevenue, profitCash, profitFull, roi, breakEven, status,
  };
}

function hoStatusLabel(s) {
  if (s === "good") return { t: "Выгодно", cls: "ho-good" };
  if (s === "edge") return { t: "На грани", cls: "ho-edge" };
  if (s === "bad") return { t: "Убыточно", cls: "ho-bad" };
  return { t: "Нет цен", cls: "ho-nodata" };
}

function hoFmt(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === Infinity) return "∞";
  return Math.round(n).toLocaleString("ru-RU") + " ₽";
}
function hoIconHtml(id, name) {
  const letter = String(name || id || "?").replace(/[«»"]/g,"").trim().charAt(0).toUpperCase() || "?";
  if (!id) return `<span class="ho-ph">${hoEsc(letter)}</span>`;
  const src = `/api/icon/${encodeURIComponent(id)}`;
  return `<img src="${src}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.style.display='flex')"><span class="ho-ph" style="display:none">${hoEsc(letter)}</span>`;
}
function hoFmtN(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

async function hoLoadRecipes() {
  if (hoLoaded && hoRecipes.length) return;
  const paths = ["/hideout_recipes.json", "/api/hideout/recipes", "/assets/hideout_recipes.json", "hideout_recipes.json"];
  let lastErr = null;
  for (const url of paths) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) { lastErr = new Error("HTTP " + r.status); continue; }
      const text = await r.text();
      if (text.trimStart().startsWith("<")) { lastErr = new Error("HTML at " + url); continue; }
      const j = JSON.parse(text);
      hoRecipes = Array.isArray(j) ? j : [];
      if (hoRecipes.length) { hoLoaded = true; return; }
    } catch (e) { lastErr = e; }
  }
  console.warn("hideout recipes failed", lastErr);
  hoRecipes = [];
  hoLoaded = false;
}

function hoPerkName(recipe) {
  const p = recipe.perks || {};
  const keys = Object.keys(p);
  if (!keys.length) return "";
  const map = {
    ammunition: "Боеприпасы", pyrotechnics: "Пиротехника", armorer: "Бронепластины",
    engineering: "Инженерия", cooking: "Кулинария", brewing: "Самогоноварение",
    medicine: "Медицина", materials: "Сырьё и материалы",
  };
  return keys.map(k => `${map[k]||k} · ур. ${p[k]}`).join(", ");
}

function hoFiltered() {
  let list = hoRecipes.slice();
  const q = (hoState.q || "").trim().toLowerCase();
  const has = (hoState.hasItem || "").trim().toLowerCase();
  if (hoState.bench) list = list.filter(r => r.bench === hoState.bench);
  if (hoState.cat) list = list.filter(r => r.category === hoState.cat);
  if (q) {
    list = list.filter(r => {
      const blob = [r.result?.name, r.category, r.subcategory, r.benchName].join(" ").toLowerCase();
      return blob.includes(q);
    });
  }
  if (has) {
    list = list.filter(r => (r.ingredients || []).some(i => (i.name || "").toLowerCase().includes(has) || (i.id || "").toLowerCase() === has));
  }
  const minP = Number(String(hoState.minProfit || "0").replace(/\s/g, "")) || 0;
  const minR = Number(String(hoState.minRoi || "0").replace(",", ".")) || 0;
  const budget = Number(String(hoState.budget || "").replace(/\s/g, ""));

  const withCalc = list.map(r => {
    const crafts = Math.max(1, Number(hoState.crafts[r.id]) || 1);
    return { r, c: hoCalc(r, crafts), crafts };
  });

  let filtered = withCalc;
  if (minP > 0) filtered = filtered.filter(x => x.c.profitCash != null && x.c.profitCash >= minP);
  if (minR > 0) filtered = filtered.filter(x => x.c.roi != null && x.c.roi >= minR);
  if (Number.isFinite(budget) && budget > 0) filtered = filtered.filter(x => x.c.buyCost != null && x.c.buyCost <= budget);

  const sort = hoState.sort || "profit";
  filtered.sort((a, b) => {
    if (sort === "name") return (a.r.result?.name || "").localeCompare(b.r.result?.name || "", "ru");
    if (sort === "cost") return (a.c.buyCost ?? 1e15) - (b.c.buyCost ?? 1e15);
    if (sort === "roi") {
      const ar = a.c.roi === Infinity ? 1e12 : (a.c.roi ?? -1e12);
      const br = b.c.roi === Infinity ? 1e12 : (b.c.roi ?? -1e12);
      return br - ar;
    }
    if (sort === "liq") return (b.c.sales || 0) - (a.c.sales || 0);
    return (b.c.profitCash ?? -1e15) - (a.c.profitCash ?? -1e15);
  });
  return filtered;
}

function hoHero(list) {
  const box = document.getElementById("hoTop");
  if (!box) return;
  const good = list.filter(x => x.c.profitCash != null);
  let bestRoi = null, bestFlip = null;
  for (const x of good) {
    if (x.c.roi != null && (bestRoi == null || (x.c.roi === Infinity ? 1e12 : x.c.roi) > (bestRoi.c.roi === Infinity ? 1e12 : bestRoi.c.roi))) bestRoi = x;
    if (x.c.profitCash != null && (bestFlip == null || x.c.profitCash > bestFlip.c.profitCash)) bestFlip = x;
  }
  const roiTxt = bestRoi ? (bestRoi.c.roi === Infinity ? "∞" : Math.round(bestRoi.c.roi) + "%") : "—";
  const flipTxt = bestFlip && bestFlip.c.profitCash != null
    ? (bestFlip.c.profitCash >= 0 ? "+" : "") + Math.round(bestFlip.c.profitCash).toLocaleString("ru-RU")
    : "—";
  box.innerHTML = `
    <div class="ho-hero">
      <div class="ho-hero-left">
        <div class="ho-hero-kicker">Калькулятор крафта · Убежище</div>
        <div class="ho-hero-title">Самые <span>выгодные</span><br>крафты</div>
        <div class="ho-hero-sub">Себестоимость, прибыль, ROI по живым ценам аукциона</div>
      </div>
      <div class="ho-hero-stats">
        <div class="ho-hero-stat">
          <div class="ho-hero-num pos">${esc(roiTxt)}</div>
          <div class="sub">лучший ROI${bestRoi ? " · " + esc(bestRoi.r.result?.name || "") : ""}</div>
        </div>
        <div class="ho-hero-stat">
          <div class="ho-hero-num pos">${esc(flipTxt)}</div>
          <div class="sub">лучший флип${bestFlip ? " · " + esc(bestFlip.r.result?.name || "") : ""}</div>
        </div>
      </div>
    </div>`;
}

function hoCardHtml(x, idx) {
  const { r, c, crafts } = x;
  const st = hoStatusLabel(c.status);
  const outAmt = r.result?.amount || 1;
  const perk = hoPerkName(r);
  const profitCls = c.profitCash > 0 ? "pos" : c.profitCash < 0 ? "neg" : "";
  const liq = c.sales > 0 ? `≈${hoFmtN(c.sales)}/день` : "—";
  const ings = (r.ingredients || []).map(ing => {
    const pi = hoPrice(ing.id);
    const priceStr = pi.price != null ? hoFmt(pi.price) : "—";
    const need = (Number(ing.amount) || 0) * crafts;
    return `<div class="ho-ing">
      <span class="ho-ing-ico">${hoIconHtml(ing.id, ing.name)}</span>
      <span class="ho-ing-q">${need}×</span>
      <span class="ho-ing-n">${esc(ing.name)}</span>
      <span class="ho-ing-p sub">${priceStr}</span>
    </div>`;
  }).join("");

  return `<div class="ho-card-row ${st.cls}" data-ho-id="${esc(r.id)}">
    <div class="ho-card-top">
      <div class="ho-card-left">
        <span class="ho-num">${idx + 1}</span>
        <div class="ho-icon">${hoIconHtml(r.result?.id, r.result?.name)}</div>
        <div class="ho-card-title">
          <div class="ho-name"><b>${outAmt * crafts}×</b> «${esc(r.result?.name || r.id)}»</div>
          <div class="sub">${esc(r.category || r.benchName)}${perk ? " · " + esc(perk) : ""}</div>
          <button type="button" class="ho-qty-btn" data-ho-qty="${esc(r.id)}">Крафтов: ${crafts} ▾</button>
        </div>
      </div>
      <div class="ho-card-metrics">
        <div class="ho-m"><span class="sub">Себест.</span><b>${hoFmt(c.buyCost)}</b></div>
        <div class="ho-m"><span class="sub">Продажа</span><b>${hoFmt(c.gross)}</b></div>
        <div class="ho-m"><span class="sub">Прибыль</span><b class="${profitCls}">${hoFmt(c.profitCash)}</b></div>
        <div class="ho-m"><span class="sub">ROI</span><b class="${profitCls}">${c.roi === Infinity ? "∞" : (c.roi != null ? c.roi + "%" : "—")}</b></div>
        <div class="ho-m"><span class="sub">Ликв.</span><span class="ho-liq">${liq}</span></div>
      </div>
    </div>
    <div class="ho-card-ings">${ings || '<span class="sub">нет ингредиентов</span>'}</div>
  </div>`;
}

function hoRenderGrid(list) {
  const box = document.getElementById("hoGrid");
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<div class="empty">Нет рецептов по фильтру</div>`;
    return;
  }
  const html = list.slice(0, 150).map((x, i) => hoCardHtml(x, i)).join("");
  box.innerHTML = `<div class="ho-cards-list">${html}</div>`;

  box.querySelectorAll(".ho-card-row").forEach(el => {
    el.addEventListener("click", e => {
      if (e.target.closest("[data-ho-qty]")) return;
      const id = el.dataset.hoId;
      hoState.selected = id; hoSave(); hoShowDetail(id);
    });
  });
  box.querySelectorAll("[data-ho-qty]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const id = btn.dataset.hoQty;
      const cur = Math.max(1, Number(hoState.crafts[id]) || 1);
      const next = prompt("Сколько крафтов?", String(cur));
      if (next == null) return;
      const v = Math.max(1, Math.floor(Number(String(next).replace(/\s/g, "")) || 1));
      hoState.crafts[id] = v; hoSave(); renderHideout();
    });
  });
}

function hoShowDetail(id) {
  const box = document.getElementById("hoDetail");
  if (!box) return;
  const recipe = hoRecipes.find(r => r.id === id);
  if (!recipe) { box.style.display = "none"; return; }
  const crafts = Math.max(1, Number(hoState.crafts[id]) || 1);
  const c = hoCalc(recipe, crafts);
  const st = hoStatusLabel(c.status);
  const outId = recipe.result?.id;

  const linesHtml = c.lines.map(l => `
    <tr>
      <td class="ho-res-cell"><span class="ho-ing-ico">${hoIconHtml(l.id, l.name)}</span><span>${esc(l.name)}</span></td>
      <td>${l.need}</td>
      <td><input type="text" inputmode="numeric" data-ho-stock="${esc(l.id)}" value="${l.own || ""}" placeholder="0" style="width:56px"></td>
      <td>${l.toBuy}</td>
      <td><input type="text" inputmode="decimal" data-ho-price="${esc(l.id)}" value="${hoState.manualPrice[l.id] ?? (l.unit != null ? l.unit : "")}" placeholder="авто" style="width:80px"></td>
      <td class="sub">${l.source === "market" ? "аукцион" : l.source === "manual" ? "ручная" : "нет"}</td>
      <td>${hoFmt(l.lineBuy)}</td>
    </tr>`).join("");

  // modal overlay — stay in place, no jump to bottom
  let overlay = document.getElementById("hoOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "hoOverlay";
    overlay.className = "ho-overlay";
    document.body.appendChild(overlay);
  }
  overlay.style.display = "flex";
  document.body.classList.add("ho-modal-open");
  const closeModal = () => {
    overlay.style.display = "none";
    document.body.classList.remove("ho-modal-open");
    hoState.selected = null;
    hoSave();
  };
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

  box.style.display = "none"; // detail panel in-page no longer used
  overlay.innerHTML = `<div class="ho-modal" role="dialog">
    <div class="ho-detail-head">
      <button type="button" class="btn" id="hoDetailClose">✕</button>
      <div class="ho-icon" style="width:40px;height:40px">${hoIconHtml(recipe.result?.id, recipe.result?.name)}</div>
      <div class="ho-name">${esc(recipe.result?.name || id)}</div>
      <span class="ho-badge ${st.cls}">${st.t}</span>
    </div>
    <div class="sub" style="margin:6px 0">${esc(recipe.benchName)} · ${esc(recipe.category)}${recipe.subcategory ? " · " + esc(recipe.subcategory) : ""} · ${esc(hoPerkName(recipe))} · энергия ${recipe.energy || 0}</div>
    <div class="ho-recipe-visual">
      ${(recipe.ingredients||[]).map(ing => {
        const need = (Number(ing.amount)||0) * crafts;
        return `<div class="ho-rv-item">
          <div class="ho-rv-icon">${hoIconHtml(ing.id, ing.name)}</div>
          <div class="ho-rv-q">${need}×</div>
          <div class="ho-rv-name">${esc(ing.name)}</div>
        </div>`;
      }).join('<div class="ho-rv-plus">+</div>')}
      <div class="ho-rv-plus">→</div>
      <div class="ho-rv-item ho-rv-out">
        <div class="ho-rv-icon">${hoIconHtml(recipe.result?.id, recipe.result?.name)}</div>
        <div class="ho-rv-q">${c.outQty}×</div>
        <div class="ho-rv-name">${esc(recipe.result?.name || id)}</div>
      </div>
    </div>
    <div class="ho-detail-controls">
      <label>Крафтов <input id="hoCrafts" type="text" inputmode="numeric" value="${crafts}" style="width:64px"></label>
      <label>Цена продажи / шт. <input id="hoSell" type="text" inputmode="decimal" value="${hoState.manualPrice[outId] ?? (c.sellUnit != null ? c.sellUnit : "")}" placeholder="авто" style="width:90px"></label>
      <span class="sub">выход: ${c.outQty} шт.</span>
    </div>
    <div class="ho-detail-stats">
      <div><span class="sub">Себестоимость</span><b>${hoFmt(c.buyCost)}</b></div>
      <div><span class="sub">Выручка</span><b>${hoFmt(c.gross)}</b></div>
      <div><span class="sub">Комиссия 5%</span><b>${hoFmt(c.fee)}</b></div>
      <div><span class="sub">Чистая прибыль</span><b class="${c.profitCash > 0 ? "pos" : c.profitCash < 0 ? "neg" : ""}">${hoFmt(c.profitCash)}</b></div>
      <div><span class="sub">ROI</span><b>${c.roi === Infinity ? "∞" : (c.roi != null ? c.roi + "%" : "—")}</b></div>
      <div><span class="sub">Безубыток / шт.</span><b>${hoFmt(c.breakEven)}</b></div>
    </div>
    <div class="section">Ресурсы</div>
    <div class="table-scroll"><table class="mini ho-table">
      <thead><tr><th>Ресурс</th><th>Нужно</th><th>Есть</th><th>Купить</th><th>Цена/шт</th><th>Источник</th><th>Сумма</th></tr></thead>
      <tbody>${linesHtml}</tbody>
    </table></div>
  </div>`;

  document.getElementById("hoDetailClose").onclick = (e) => { e.stopPropagation(); closeModal(); };
  document.getElementById("hoCrafts").oninput = (e) => {
    const v = Math.max(1, Math.floor(Number(String(e.target.value).replace(/\s/g, "")) || 1));
    hoState.crafts[id] = v; hoSave(); hoShowDetail(id);
  };
  document.getElementById("hoSell").oninput = (e) => {
    const raw = e.target.value.trim();
    if (outId) {
      if (raw === "") delete hoState.manualPrice[outId];
      else hoState.manualPrice[outId] = raw;
      hoSave(); hoShowDetail(id);
    }
  };
  overlay.querySelectorAll("[data-ho-stock]").forEach(inp => {
    inp.oninput = () => {
      const iid = inp.dataset.hoStock;
      const v = String(inp.value).replace(/\s/g, "");
      if (v === "") delete hoState.stock[iid]; else hoState.stock[iid] = Number(v) || 0;
      hoSave(); hoShowDetail(id);
    };
  });
  overlay.querySelectorAll("[data-ho-price]").forEach(inp => {
    inp.oninput = () => {
      const iid = inp.dataset.hoPrice;
      const raw = inp.value.trim();
      if (raw === "") delete hoState.manualPrice[iid]; else hoState.manualPrice[iid] = raw;
      hoSave(); hoShowDetail(id);
    };
  });
  // Escape to close
  const onKey = (e) => { if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
}

function hoFillCats() {
  const sel = document.getElementById("hoCat");
  if (!sel) return;
  const cur = hoState.cat || "";
  const cats = [...new Set(hoRecipes.map(r => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  sel.innerHTML = `<option value="">Все категории</option>` + cats.map(c =>
    `<option value="${esc(c)}"${c === cur ? " selected" : ""}>${esc(c)}</option>`
  ).join("");
}

async function renderHideout() {
  const st = document.getElementById("hoStatus");
  if (st) st.textContent = "Загрузка рецептов…";
  try {
    await hoLoadRecipes();
    if (!hoRecipes.length) {
      if (st) st.textContent = "Не удалось загрузить рецепты";
      const grid = document.getElementById("hoGrid");
      if (grid) grid.innerHTML = `<div class="empty">Файл hideout_recipes.json не найден. npm run build и перезапуск сервера.</div>`;
      return;
    }
    hoFillCats();
    const q = document.getElementById("hoQ"); if (q) q.value = hoState.q || "";
    const has = document.getElementById("hoHas"); if (has) has.value = hoState.hasItem || "";
    const bench = document.getElementById("hoBench"); if (bench) bench.value = hoState.bench || "";
    const cat = document.getElementById("hoCat"); if (cat) cat.value = hoState.cat || "";
    const sort = document.getElementById("hoSort"); if (sort) sort.value = hoState.sort || "profit";
    const mp = document.getElementById("hoMinProfit"); if (mp) mp.value = hoState.minProfit || "";
    const mr = document.getElementById("hoMinRoi"); if (mr) mr.value = hoState.minRoi || "";
    const bud = document.getElementById("hoBudget"); if (bud) bud.value = hoState.budget || "";

    const list = hoFiltered();
    if (st) st.textContent = `Рецептов: ${list.length} / ${hoRecipes.length}`;
    const up = document.getElementById("hoUpdated");
    if (up) up.textContent = "цены с вашего аукциона";
    hoHero(list);
    hoRenderGrid(list);
    if (hoState.selected) hoShowDetail(hoState.selected);
    else {
      const d = document.getElementById("hoDetail"); if (d) d.style.display = "none";
      const ov = document.getElementById("hoOverlay");
      if (ov) { ov.style.display = "none"; document.body.classList.remove("ho-modal-open"); }
    }
  } catch (e) {
    console.error("renderHideout", e);
    if (st) st.textContent = "Ошибка: " + (e && e.message ? e.message : e);
  }
}

function hoBindOnce() {
  if (window._hoBound) return;
  window._hoBound = true;
  const bind = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  bind("hoQ", "input", () => {
    clearTimeout(window._hoQT);
    window._hoQT = setTimeout(() => { hoState.q = document.getElementById("hoQ")?.value || ""; hoSave(); renderHideout(); }, 120);
  });
  bind("hoHas", "input", () => {
    clearTimeout(window._hoHT);
    window._hoHT = setTimeout(() => { hoState.hasItem = document.getElementById("hoHas")?.value || ""; hoSave(); renderHideout(); }, 120);
  });
  bind("hoBench", "change", () => { hoState.bench = document.getElementById("hoBench").value; hoSave(); renderHideout(); });
  bind("hoCat", "change", () => { hoState.cat = document.getElementById("hoCat").value; hoSave(); renderHideout(); });
  bind("hoSort", "change", () => { hoState.sort = document.getElementById("hoSort").value; hoSave(); renderHideout(); });
  bind("hoMinProfit", "change", () => { hoState.minProfit = document.getElementById("hoMinProfit").value; hoSave(); renderHideout(); });
  bind("hoMinRoi", "change", () => { hoState.minRoi = document.getElementById("hoMinRoi").value; hoSave(); renderHideout(); });
  bind("hoBudget", "change", () => { hoState.budget = document.getElementById("hoBudget").value; hoSave(); renderHideout(); });
  bind("hoRefresh", "click", () => renderHideout());
  bind("hoReset", "click", () => {
    hoState.q = ""; hoState.hasItem = ""; hoState.bench = ""; hoState.cat = "";
    hoState.minProfit = 0; hoState.minRoi = 0; hoState.budget = "";
    hoSave(); renderHideout();
  });
}

window.renderHideout = renderHideout;
window.hoBindOnce = hoBindOnce;
