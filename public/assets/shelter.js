/** Убежище — крафт-калькулятор на официальных hideout_recipes */
const HO_FEE = 0.05;
const HO_LS = "sz_hideout_v1";

let hoRecipes = [];
let hoLoaded = false;
let hoState = (() => {
  try { return JSON.parse(localStorage.getItem(HO_LS) || "{}"); } catch { return {}; }
})();
if (!hoState || typeof hoState !== "object") hoState = {};
hoState = Object.assign({
  q: "", bench: "", cat: "", sort: "profit",
  minProfit: 0, minRoi: 0, budget: "",
  crafts: {}, // recipeId -> count
  stock: {},  // itemId -> owned qty
  manualPrice: {}, // itemId -> override unit price
  selected: null,
}, hoState);

function hoSave() {
  try { localStorage.setItem(HO_LS, JSON.stringify(hoState)); } catch {}
}

function hoPrice(itemId) {
  if (hoState.manualPrice[itemId] != null && hoState.manualPrice[itemId] !== "") {
    const n = Number(String(hoState.manualPrice[itemId]).replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(n) && n >= 0) return { price: n, source: "manual" };
  }
  // market rows (global from app.js)
  if (typeof rows !== "undefined" && Array.isArray(rows)) {
    const base = String(itemId);
    let best = null;
    for (const r of rows) {
      const id = String(r.id || "").replace(/@q\d+(?:p\d+)?$/, "");
      if (id !== base) continue;
      const p = r.minUnitPrice ?? r.min_price;
      if (p != null && p > 0 && (best == null || p < best)) best = p;
    }
    if (best != null) return { price: best, source: "market" };
  }
  return { price: null, source: "none" };
}

/** Unified craft economics for one recipe × craftCount */
function hoCalc(recipe, craftCount) {
  const n = Math.max(1, Math.floor(Number(craftCount) || 1));
  const ings = recipe.ingredients || [];
  const resAmt = (recipe.result && recipe.result.amount) || 1;
  const outId = recipe.result && recipe.result.id;
  const sellInfo = outId ? hoPrice(outId) : { price: null, source: "none" };
  const sellUnit = sellInfo.price;

  let matCost = 0;       // full economic cost of all mats used
  let buyCost = 0;       // cash to spend for missing stock
  let missingLines = 0;
  const lines = [];

  for (const ing of ings) {
    const need = (Number(ing.amount) || 0) * n;
    const own = Math.max(0, Number(hoState.stock[ing.id]) || 0);
    const toBuy = Math.max(0, need - own);
    const pi = hoPrice(ing.id);
    const unit = pi.price;
    const lineMat = unit != null ? unit * need : null;
    const lineBuy = unit != null ? unit * toBuy : null;
    if (lineMat != null) matCost += lineMat;
    else missingLines++;
    if (lineBuy != null) buyCost += lineBuy;
    lines.push({
      id: ing.id, name: ing.name, need, own, toBuy,
      unit, source: pi.source, lineMat, lineBuy,
    });
  }

  const outQty = resAmt * n;
  const gross = sellUnit != null ? sellUnit * outQty : null;
  const fee = gross != null ? Math.round(gross * HO_FEE) : null;
  const netRevenue = gross != null ? gross - fee : null;
  // profit vs cash spent (using stock free)
  const profitCash = netRevenue != null && missingLines === 0 ? Math.round(netRevenue - buyCost) : null;
  // profit vs full economic cost
  const profitFull = netRevenue != null && missingLines === 0 ? Math.round(netRevenue - matCost) : null;
  const roi = profitCash != null && buyCost > 0 ? Math.round((profitCash / buyCost) * 1000) / 10
    : (profitCash != null && buyCost === 0 && profitCash > 0 ? Infinity : null);
  const breakEven = (outQty > 0 && missingLines === 0)
    ? Math.ceil((buyCost / outQty) / (1 - HO_FEE))
    : null;

  let status = "nodata";
  if (missingLines > 0 || sellUnit == null) status = "nodata";
  else if (profitCash != null && profitCash > 0) status = "good";
  else if (profitCash != null && profitCash === 0) status = "edge";
  else if (profitCash != null && profitCash < 0) status = "bad";

  return {
    n, outQty, lines, matCost, buyCost, missingLines,
    sellUnit, sellSource: sellInfo.source, gross, fee, netRevenue,
    profitCash, profitFull, roi, breakEven, status,
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

async function hoLoadRecipes() {
  if (hoLoaded && hoRecipes.length) return;
  try {
    const r = await fetch("/hideout_recipes.json", { cache: "no-store" });
    const j = await r.json();
    hoRecipes = Array.isArray(j) ? j : [];
    hoLoaded = true;
  } catch (e) {
    console.warn("hideout recipes", e);
    hoRecipes = [];
  }
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

function hoFiltered() {
  let list = hoRecipes.slice();
  const q = (hoState.q || "").trim().toLowerCase();
  if (hoState.bench) list = list.filter(r => r.bench === hoState.bench);
  if (hoState.cat) list = list.filter(r => r.category === hoState.cat);
  if (q) {
    list = list.filter(r => {
      const blob = [r.result?.name, r.category, r.subcategory, r.benchName, ...(r.ingredients || []).map(i => i.name)].join(" ").toLowerCase();
      return blob.includes(q);
    });
  }
  const minP = Number(String(hoState.minProfit || "0").replace(/\s/g, "")) || 0;
  const minR = Number(String(hoState.minRoi || "0").replace(",", ".")) || 0;
  const budget = Number(String(hoState.budget || "").replace(/\s/g, ""));
  const withCalc = list.map(r => {
    const crafts = Math.max(1, Number(hoState.crafts[r.id]) || 1);
    const c = hoCalc(r, crafts);
    return { r, c, crafts };
  });

  let filtered = withCalc;
  if (minP > 0) filtered = filtered.filter(x => x.c.profitCash != null && x.c.profitCash >= minP);
  if (minR > 0) filtered = filtered.filter(x => x.c.roi != null && x.c.roi >= minR);
  if (Number.isFinite(budget) && budget > 0) {
    filtered = filtered.filter(x => x.c.buyCost != null && x.c.buyCost <= budget);
  }

  const sort = hoState.sort || "profit";
  filtered.sort((a, b) => {
    if (sort === "name") return (a.r.result?.name || "").localeCompare(b.r.result?.name || "", "ru");
    if (sort === "cost") return (a.c.buyCost ?? 1e15) - (b.c.buyCost ?? 1e15);
    if (sort === "roi") {
      const ar = a.c.roi === Infinity ? 1e12 : (a.c.roi ?? -1e12);
      const br = b.c.roi === Infinity ? 1e12 : (b.c.roi ?? -1e12);
      return br - ar;
    }
    // profit
    return (b.c.profitCash ?? -1e15) - (a.c.profitCash ?? -1e15);
  });
  return filtered;
}

function hoRenderTop(list) {
  const box = document.getElementById("hoTop");
  if (!box) return;
  const top = list.filter(x => x.c.status === "good").slice(0, 5);
  if (!top.length) {
    box.innerHTML = `<div class="ho-top-title">Самые выгодные</div><div class="sub">Пока нет прибыльных крафтов с известными ценами</div>`;
    return;
  }
  box.innerHTML = `<div class="ho-top-title">Самые выгодные крафты</div><div class="ho-top-list">` +
    top.map((x, i) => {
      const st = hoStatusLabel(x.c.status);
      return `<div class="ho-top-item" data-ho-id="${esc(x.r.id)}">
        <span class="ho-rank">${i + 1}</span>
        <span class="ho-top-name">${esc(x.r.result?.name || x.r.id)}</span>
        <span class="${st.cls}">${hoFmt(x.c.profitCash)}</span>
        <span class="sub">${x.c.roi === Infinity ? "∞" : (x.c.roi != null ? x.c.roi + "%" : "—")}</span>
      </div>`;
    }).join("") + `</div>`;
  box.querySelectorAll("[data-ho-id]").forEach(el => {
    el.onclick = () => { hoState.selected = el.dataset.hoId; hoSave(); hoShowDetail(el.dataset.hoId); };
  });
}

function hoCardHtml(x) {
  const { r, c } = x;
  const st = hoStatusLabel(c.status);
  const icon = r.result?.id ? `/api/icon/${encodeURIComponent(r.result.id)}` : "";
  return `<div class="ho-card ${st.cls}" data-ho-id="${esc(r.id)}">
    <div class="ho-card-top">
      <div class="ho-icon">${icon ? `<img src="${icon}" alt="" loading="lazy" onerror="this.style.display='none'">` : ""}</div>
      <div class="ho-card-meta">
        <div class="ho-name">${esc(r.result?.name || r.id)}</div>
        <div class="sub">${esc(r.benchName)} · ${esc(r.category)}${r.subcategory ? " / " + esc(r.subcategory) : ""}</div>
      </div>
      <span class="ho-badge ${st.cls}">${st.t}</span>
    </div>
    <div class="ho-card-stats">
      <div><span class="sub">Закуп</span><b>${hoFmt(c.buyCost)}</b></div>
      <div><span class="sub">Продажа</span><b>${hoFmt(c.gross)}</b></div>
      <div><span class="sub">Чистыми</span><b class="${c.profitCash > 0 ? "pos" : c.profitCash < 0 ? "neg" : ""}">${hoFmt(c.profitCash)}</b></div>
      <div><span class="sub">ROI</span><b>${c.roi === Infinity ? "∞" : (c.roi != null ? c.roi + "%" : "—")}</b></div>
    </div>
  </div>`;
}

function hoRenderGrid(list) {
  const box = document.getElementById("hoGrid");
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<div class="empty">Нет рецептов по фильтру. Снимите ограничения или дождитесь цен аукциона.</div>`;
    return;
  }
  box.innerHTML = list.slice(0, 120).map(hoCardHtml).join("");
  box.querySelectorAll("[data-ho-id]").forEach(el => {
    el.onclick = () => { hoState.selected = el.dataset.hoId; hoSave(); hoShowDetail(el.dataset.hoId); };
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
      <td>${esc(l.name)}</td>
      <td>${l.need}</td>
      <td><input type="text" inputmode="numeric" data-ho-stock="${esc(l.id)}" value="${l.own || ""}" placeholder="0" style="width:56px"></td>
      <td>${l.toBuy}</td>
      <td><input type="text" inputmode="decimal" data-ho-price="${esc(l.id)}" value="${hoState.manualPrice[l.id] ?? (l.unit != null ? l.unit : "")}" placeholder="авто" style="width:80px"></td>
      <td class="sub">${l.source === "market" ? "аукцион" : l.source === "manual" ? "ручная" : "нет"}</td>
      <td>${hoFmt(l.lineBuy)}</td>
    </tr>`).join("");

  box.style.display = "block";
  box.innerHTML = `
    <div class="ho-detail-head">
      <button type="button" class="btn" id="hoDetailClose">← К списку</button>
      <div class="ho-name">${esc(recipe.result?.name || id)}</div>
      <span class="ho-badge ${st.cls}">${st.t}</span>
    </div>
    <div class="sub" style="margin:6px 0">${esc(recipe.benchName)} · ${esc(recipe.category)}${recipe.subcategory ? " · " + esc(recipe.subcategory) : ""} · энергия ${recipe.energy || 0}</div>
    <div class="ho-detail-controls">
      <label>Крафтов <input id="hoCrafts" type="text" inputmode="numeric" value="${crafts}" style="width:64px"></label>
      <label>Цена продажи / шт. <input id="hoSell" type="text" inputmode="decimal" value="${hoState.manualPrice[outId] ?? (c.sellUnit != null ? c.sellUnit : "")}" placeholder="авто" style="width:90px"></label>
      <span class="sub">выход: ${c.outQty} шт. за ${crafts} крафт(ов)</span>
    </div>
    <div class="ho-detail-stats">
      <div><span class="sub">Материалы (все)</span><b>${hoFmt(c.matCost)}</b></div>
      <div><span class="sub">К доплате</span><b>${hoFmt(c.buyCost)}</b></div>
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
    <div class="sub" style="margin-top:8px">Цены с аукциона (мин. лот). Пустое поле «Есть» = 0. Ручная цена перекрывает аукцион. Комиссия продажи 5%.</div>
  `;

  document.getElementById("hoDetailClose").onclick = () => {
    box.style.display = "none";
    hoState.selected = null;
    hoSave();
  };
  const craftsEl = document.getElementById("hoCrafts");
  craftsEl.oninput = () => {
    const v = Math.max(1, Math.floor(Number(String(craftsEl.value).replace(/\s/g, "")) || 1));
    hoState.crafts[id] = v;
    hoSave();
    hoShowDetail(id);
  };
  const sellEl = document.getElementById("hoSell");
  sellEl.oninput = () => {
    const raw = sellEl.value.trim();
    if (outId) {
      if (raw === "") delete hoState.manualPrice[outId];
      else hoState.manualPrice[outId] = raw;
      hoSave();
      hoShowDetail(id);
    }
  };
  box.querySelectorAll("[data-ho-stock]").forEach(inp => {
    inp.oninput = () => {
      const iid = inp.dataset.hoStock;
      const v = String(inp.value).replace(/\s/g, "");
      if (v === "") delete hoState.stock[iid];
      else hoState.stock[iid] = Number(v) || 0;
      hoSave();
      hoShowDetail(id);
    };
  });
  box.querySelectorAll("[data-ho-price]").forEach(inp => {
    inp.oninput = () => {
      const iid = inp.dataset.hoPrice;
      const raw = inp.value.trim();
      if (raw === "") delete hoState.manualPrice[iid];
      else hoState.manualPrice[iid] = raw;
      hoSave();
      hoShowDetail(id);
    };
  });
}

async function renderHideout() {
  const st = document.getElementById("hoStatus");
  if (st) st.textContent = "Загрузка рецептов…";
  await hoLoadRecipes();
  hoFillCats();
  // restore controls
  const q = document.getElementById("hoQ");
  if (q) q.value = hoState.q || "";
  const bench = document.getElementById("hoBench");
  if (bench) bench.value = hoState.bench || "";
  const cat = document.getElementById("hoCat");
  if (cat) cat.value = hoState.cat || "";
  const sort = document.getElementById("hoSort");
  if (sort) sort.value = hoState.sort || "profit";
  const mp = document.getElementById("hoMinProfit");
  if (mp) mp.value = hoState.minProfit || "";
  const mr = document.getElementById("hoMinRoi");
  if (mr) mr.value = hoState.minRoi || "";
  const bud = document.getElementById("hoBudget");
  if (bud) bud.value = hoState.budget || "";

  const list = hoFiltered();
  if (st) st.textContent = `Рецептов: ${list.length} / ${hoRecipes.length}`;
  const up = document.getElementById("hoUpdated");
  if (up) up.textContent = typeof marketUpdatedAt !== "undefined" && marketUpdatedAt
    ? "цены: " + new Date(marketUpdatedAt).toLocaleTimeString("ru-RU")
    : "";
  hoRenderTop(list);
  hoRenderGrid(list);
  if (hoState.selected) hoShowDetail(hoState.selected);
  else {
    const d = document.getElementById("hoDetail");
    if (d) d.style.display = "none";
  }
}

function hoBindOnce() {
  if (window._hoBound) return;
  window._hoBound = true;
  const bind = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };
  bind("hoQ", "input", () => {
    clearTimeout(window._hoQT);
    window._hoQT = setTimeout(() => {
      hoState.q = document.getElementById("hoQ")?.value || "";
      hoSave(); renderHideout();
    }, 120);
  });
  bind("hoBench", "change", () => { hoState.bench = document.getElementById("hoBench").value; hoSave(); renderHideout(); });
  bind("hoCat", "change", () => { hoState.cat = document.getElementById("hoCat").value; hoSave(); renderHideout(); });
  bind("hoSort", "change", () => { hoState.sort = document.getElementById("hoSort").value; hoSave(); renderHideout(); });
  bind("hoMinProfit", "change", () => { hoState.minProfit = document.getElementById("hoMinProfit").value; hoSave(); renderHideout(); });
  bind("hoMinRoi", "change", () => { hoState.minRoi = document.getElementById("hoMinRoi").value; hoSave(); renderHideout(); });
  bind("hoBudget", "change", () => { hoState.budget = document.getElementById("hoBudget").value; hoSave(); renderHideout(); });
  bind("hoRefresh", "click", () => renderHideout());
}

// export for app.js
window.renderHideout = renderHideout;
window.hoBindOnce = hoBindOnce;
