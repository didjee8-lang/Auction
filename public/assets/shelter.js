/** Убежище — крафт с нуля: сетка 3 карточки, цены из API + аукцион */
const HO_FEE = 0.05;
const HO_LS = "sz_hideout_v1";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtMoney(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === Infinity) return "∞";
  return Math.round(n).toLocaleString("ru-RU") + " ₽";
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

function baseId(id) {
  return String(id || "").replace(/@q\d+(?:p\d+)?$/, "");
}

function getMarketRows() {
  try {
    if (typeof window !== "undefined" && Array.isArray(window.rows)) return window.rows;
  } catch {}
  try {
    if (typeof rows !== "undefined" && Array.isArray(rows)) return rows;
  } catch {}
  return [];
}

function iconHtml(id, name) {
  const letter = String(name || id || "?")
    .replace(/[«»"]/g, "")
    .trim()
    .charAt(0)
    .toUpperCase() || "?";
  if (!id) return `<span class="ho2-ph">${esc(letter)}</span>`;
  return `<img src="/api/icon/${encodeURIComponent(baseId(id))}" alt="" loading="lazy" decoding="async" onerror="this.style.display='none';var n=this.nextElementSibling;if(n)n.style.display='flex'"><span class="ho2-ph" style="display:none">${esc(letter)}</span>`;
}

let recipes = [];
let loaded = false;
let priceMap = Object.create(null); // id -> {price, source, soldPerDay}
let priceAt = 0;

let state = (() => {
  try {
    return JSON.parse(localStorage.getItem(HO_LS) || "{}") || {};
  } catch {
    return {};
  }
})();
state = Object.assign(
  {
    q: "",
    has: "",
    bench: "",
    cat: "",
    sort: "profit",
    minProfit: "",
    minRoi: "",
    budget: "",
    crafts: {},
    stock: {},
    manualPrice: {},
    selected: null,
  },
  state
);

function save() {
  try {
    localStorage.setItem(HO_LS, JSON.stringify(state));
  } catch {}
}

function priceOf(itemId) {
  const id = baseId(itemId);
  if (!id) return { price: null, source: "none", sales: 0 };

  const man = state.manualPrice[id];
  if (man != null && man !== "") {
    const n = Number(String(man).replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(n) && n >= 0) return { price: n, source: "manual", sales: 0 };
  }

  const c = priceMap[id];
  if (c && c.price != null && c.price > 0) {
    return { price: c.price, source: c.source || "db", sales: c.soldPerDay || 0 };
  }

  // live auction rows
  let best = null;
  let sales = 0;
  for (const r of getMarketRows()) {
    if (baseId(r.id) !== id) continue;
    for (const p of [r.minUnitPrice, r.min_price, r.minPrice, r.lastSale]) {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0 && (best == null || n < best)) best = n;
    }
    const s = Number(r.soldPerDay || r.sales7d || 0) || 0;
    if (s > sales) sales = s;
  }
  if (best != null) return { price: best, source: "market", sales };
  return { price: null, source: "none", sales: 0 };
}

function calc(recipe, nCrafts) {
  const n = Math.max(1, Math.floor(Number(nCrafts) || 1));
  const ings = recipe.ingredients || [];
  const resAmt = (recipe.result && recipe.result.amount) || 1;
  const outId = recipe.result && recipe.result.id;
  const sell = outId ? priceOf(outId) : { price: null, source: "none", sales: 0 };

  let buyCost = 0;
  let missing = 0;
  const lines = [];
  for (const ing of ings) {
    const need = (Number(ing.amount) || 0) * n;
    const own = Math.max(0, Number(state.stock[ing.id]) || 0);
    const toBuy = Math.max(0, need - own);
    const pi = priceOf(ing.id);
    if (pi.price == null) missing++;
    else buyCost += pi.price * toBuy;
    lines.push({
      id: ing.id,
      name: ing.name,
      need,
      own,
      toBuy,
      unit: pi.price,
      source: pi.source,
      sum: pi.price != null ? pi.price * toBuy : null,
    });
  }

  const outQty = resAmt * n;
  const gross = sell.price != null ? sell.price * outQty : null;
  const fee = gross != null ? Math.round(gross * HO_FEE) : null;
  const net = gross != null ? gross - fee : null;
  const profit = net != null && missing === 0 ? Math.round(net - buyCost) : null;
  const roi =
    profit != null && buyCost > 0
      ? Math.round((profit / buyCost) * 1000) / 10
      : profit != null && buyCost === 0 && profit > 0
        ? Infinity
        : null;

  let status = "nodata";
  if (missing === 0 && sell.price != null) {
    if (profit > 0) status = "good";
    else if (profit < 0) status = "bad";
    else status = "edge";
  }

  return {
    n,
    outQty,
    lines,
    buyCost: missing ? null : buyCost,
    missing,
    sellUnit: sell.price,
    sales: sell.sales || 0,
    gross,
    fee,
    net,
    profit,
    roi,
    status,
  };
}

function perkText(recipe) {
  const p = recipe.perks || {};
  const map = {
    ammunition: "Боеприпасы",
    pyrotechnics: "Пиротехника",
    armorer: "Бронепластины",
    engineering: "Инженерия",
    cooking: "Кулинария",
    brewing: "Самогоноварение",
    medicine: "Медицина",
    materials: "Сырьё",
  };
  return Object.keys(p)
    .map((k) => `${map[k] || k} · ур. ${p[k]}`)
    .join(", ");
}

function statusLabel(st) {
  if (st === "good") return { t: "Выгодно", cls: "good" };
  if (st === "bad") return { t: "Убыток", cls: "bad" };
  if (st === "edge") return { t: "Ноль", cls: "edge" };
  return { t: "Нет цен", cls: "nodata" };
}

async function loadRecipes() {
  if (loaded && recipes.length) return;
  const urls = ["/hideout_recipes.json", "/api/hideout/recipes", "/assets/hideout_recipes.json"];
  for (const url of urls) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) continue;
      const text = await r.text();
      if (text.trimStart().startsWith("<")) continue;
      const j = JSON.parse(text);
      if (Array.isArray(j) && j.length) {
        recipes = j;
        loaded = true;
        return;
      }
    } catch {}
  }
  recipes = [];
  loaded = false;
}

async function loadPrices() {
  const ids = new Set();
  for (const r of recipes) {
    if (r.result?.id) ids.add(baseId(r.result.id));
    for (const ing of r.ingredients || []) if (ing.id) ids.add(baseId(ing.id));
  }

  // seed from live market
  for (const r of getMarketRows()) {
    const id = baseId(r.id);
    if (!id) continue;
    let best = null;
    for (const p of [r.minUnitPrice, r.min_price, r.minPrice, r.lastSale]) {
      const n = Number(p);
      if (Number.isFinite(n) && n > 0 && (best == null || n < best)) best = n;
    }
    if (best != null) {
      priceMap[id] = {
        price: best,
        source: "market",
        soldPerDay: Number(r.soldPerDay || 0) || 0,
      };
    }
  }

  const list = [...ids];
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    try {
      const res = await fetch("/api/hideout/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: part }),
      });
      if (!res.ok) continue;
      const j = await res.json();
      if (!j?.prices) continue;
      for (const [id, info] of Object.entries(j.prices)) {
        if (!info || info.price == null || !(info.price > 0)) continue;
        const prev = priceMap[id];
        if (!prev || prev.price == null || info.price < prev.price) {
          priceMap[id] = {
            price: info.price,
            source: info.source || "db",
            soldPerDay: info.soldPerDay || 0,
          };
        } else if (prev && info.soldPerDay) {
          prev.soldPerDay = info.soldPerDay;
        }
      }
    } catch (e) {
      console.warn("hideout prices", e);
    }
  }
  priceAt = Date.now();
}

function filtered() {
  let list = recipes.slice();
  const q = (state.q || "").trim().toLowerCase();
  const has = (state.has || "").trim().toLowerCase();
  if (state.bench) list = list.filter((r) => r.bench === state.bench);
  if (state.cat) list = list.filter((r) => r.category === state.cat);
  if (q) {
    list = list.filter((r) =>
      [r.result?.name, r.category, r.subcategory, r.benchName].join(" ").toLowerCase().includes(q)
    );
  }
  if (has) {
    list = list.filter((r) =>
      (r.ingredients || []).some(
        (i) => (i.name || "").toLowerCase().includes(has) || (i.id || "").toLowerCase() === has
      )
    );
  }

  const minP = Number(String(state.minProfit || "").replace(/\s/g, "")) || 0;
  const minR = Number(String(state.minRoi || "").replace(",", ".")) || 0;
  const budget = Number(String(state.budget || "").replace(/\s/g, ""));

  const withCalc = list.map((r) => {
    const crafts = Math.max(1, Number(state.crafts[r.id]) || 1);
    return { r, c: calc(r, crafts), crafts };
  });

  let out = withCalc;
  if (minP > 0) out = out.filter((x) => x.c.profit != null && x.c.profit >= minP);
  if (minR > 0) out = out.filter((x) => x.c.roi != null && x.c.roi >= minR);
  if (Number.isFinite(budget) && budget > 0)
    out = out.filter((x) => x.c.buyCost != null && x.c.buyCost <= budget);

  const sort = state.sort || "profit";
  out.sort((a, b) => {
    if (sort === "name") return (a.r.result?.name || "").localeCompare(b.r.result?.name || "", "ru");
    if (sort === "cost") return (a.c.buyCost ?? 1e15) - (b.c.buyCost ?? 1e15);
    if (sort === "roi") {
      const ar = a.c.roi === Infinity ? 1e12 : a.c.roi ?? -1e12;
      const br = b.c.roi === Infinity ? 1e12 : b.c.roi ?? -1e12;
      return br - ar;
    }
    if (sort === "liq") return (b.c.sales || 0) - (a.c.sales || 0);
    return (b.c.profit ?? -1e15) - (a.c.profit ?? -1e15);
  });
  return out;
}

function cardHtml(x, idx) {
  const { r, c, crafts } = x;
  const st = statusLabel(c.status);
  const outAmt = r.result?.amount || 1;
  const profitCls = c.profit > 0 ? "pos" : c.profit < 0 ? "neg" : "";
  const ings = (r.ingredients || [])
    .map((ing) => {
      const pi = priceOf(ing.id);
      const need = (Number(ing.amount) || 0) * crafts;
      return `<div class="ho2-ing">
        <span class="ho2-ing-ico">${iconHtml(ing.id, ing.name)}</span>
        <span class="ho2-ing-txt"><b>${need}×</b> ${esc(ing.name)}</span>
        <span class="ho2-ing-p">${fmtMoney(pi.price)}</span>
      </div>`;
    })
    .join("");

  return `<article class="ho2-card ${st.cls}" data-id="${esc(r.id)}" style="grid-column: span 1">
    <header class="ho2-card-h">
      <span class="ho2-idx">${idx + 1}</span>
      <div class="ho2-ico">${iconHtml(r.result?.id, r.result?.name)}</div>
      <div class="ho2-titles">
        <div class="ho2-name"><b>${outAmt * crafts}×</b> ${esc(r.result?.name || r.id)}</div>
        <div class="ho2-sub">${esc(r.category || r.benchName)}</div>
        <div class="ho2-perk">${esc(perkText(r) || r.benchName || "")}</div>
      </div>
      <span class="ho2-badge ${st.cls}">${st.t}</span>
    </header>
    <div class="ho2-ings">${ings}</div>
    <footer class="ho2-stats">
      <div><span>Себест.</span><b>${fmtMoney(c.buyCost)}</b></div>
      <div><span>Продажа</span><b>${fmtMoney(c.gross)}</b></div>
      <div><span>Прибыль</span><b class="${profitCls}">${fmtMoney(c.profit)}</b></div>
      <div><span>ROI</span><b class="${profitCls}">${c.roi === Infinity ? "∞" : c.roi != null ? c.roi + "%" : "—"}</b></div>
    </footer>
    <button type="button" class="ho2-qty" data-qty="${esc(r.id)}">Крафтов: ${crafts}</button>
  </article>`;
}

function renderList(list) {
  const box = document.getElementById("hoGrid");
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<div class="empty">Нет рецептов по фильтру</div>`;
    return;
  }
  // Явная сетка 3 колонки — без вложенных обёрток, которые ломали layout
  box.className = "ho2-grid";
  box.innerHTML = list.slice(0, 180).map((x, i) => cardHtml(x, i)).join("");

  box.querySelectorAll(".ho2-card").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-qty]")) return;
      state.selected = el.dataset.id;
      save();
      openModal(el.dataset.id);
    });
  });
  box.querySelectorAll("[data-qty]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.dataset.qty;
      const cur = Math.max(1, Number(state.crafts[id]) || 1);
      const next = prompt("Сколько крафтов?", String(cur));
      if (next == null) return;
      state.crafts[id] = Math.max(1, Math.floor(Number(String(next).replace(/\s/g, "")) || 1));
      save();
      renderHideout();
    });
  });
}

function renderHero(list) {
  const box = document.getElementById("hoTop");
  if (!box) return;
  let bestRoi = null;
  let bestFlip = null;
  for (const x of list) {
    if (x.c.roi == null) continue;
    const rv = x.c.roi === Infinity ? 1e12 : x.c.roi;
    if (!bestRoi || rv > (bestRoi.c.roi === Infinity ? 1e12 : bestRoi.c.roi)) bestRoi = x;
    if (x.c.profit != null && (!bestFlip || x.c.profit > bestFlip.c.profit)) bestFlip = x;
  }
  const roiTxt = bestRoi ? (bestRoi.c.roi === Infinity ? "∞" : Math.round(bestRoi.c.roi) + "%") : "—";
  const flipTxt =
    bestFlip && bestFlip.c.profit != null
      ? (bestFlip.c.profit >= 0 ? "+" : "") + Math.round(bestFlip.c.profit).toLocaleString("ru-RU")
      : "—";
  box.innerHTML = `<div class="ho2-hero">
    <div>
      <div class="ho2-hero-k">Калькулятор крафта · Убежище</div>
      <div class="ho2-hero-t">Самые <em>выгодные</em> крафты</div>
    </div>
    <div class="ho2-hero-stats">
      <div><strong class="pos">${esc(roiTxt)}</strong><span>лучший ROI</span></div>
      <div><strong class="pos">${esc(flipTxt)}</strong><span>лучший флип</span></div>
    </div>
  </div>`;
}

function openModal(id) {
  const recipe = recipes.find((r) => r.id === id);
  if (!recipe) return;
  const crafts = Math.max(1, Number(state.crafts[id]) || 1);
  const c = calc(recipe, crafts);
  const st = statusLabel(c.status);
  const outId = recipe.result?.id;

  let overlay = document.getElementById("hoOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "hoOverlay";
    overlay.className = "ho2-overlay";
    document.body.appendChild(overlay);
  }

  const close = () => {
    overlay.style.display = "none";
    document.body.classList.remove("ho-modal-open");
    state.selected = null;
    save();
  };

  const chips = (recipe.ingredients || [])
    .map((ing) => {
      const need = (Number(ing.amount) || 0) * crafts;
      return `<div class="ho2-chip">
        <div class="ho2-chip-ico">${iconHtml(ing.id, ing.name)}</div>
        <div class="ho2-chip-q">${need}×</div>
        <div class="ho2-chip-n">${esc(ing.name)}</div>
      </div>`;
    })
    .join('<span class="ho2-plus">+</span>');

  const lines = c.lines
    .map(
      (l) => `<tr>
      <td class="ho2-td-name"><span class="ho2-ing-ico">${iconHtml(l.id, l.name)}</span>${esc(l.name)}</td>
      <td>${l.need}</td>
      <td><input data-stock="${esc(l.id)}" value="${l.own || ""}" placeholder="0"></td>
      <td>${l.toBuy}</td>
      <td><input data-price="${esc(l.id)}" value="${state.manualPrice[l.id] ?? (l.unit != null ? l.unit : "")}" placeholder="авто"></td>
      <td>${fmtMoney(l.sum)}</td>
    </tr>`
    )
    .join("");

  overlay.style.display = "flex";
  document.body.classList.add("ho-modal-open");
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };

  overlay.innerHTML = `<div class="ho2-modal" role="dialog">
    <div class="ho2-modal-h">
      <button type="button" class="btn" id="hoClose">✕</button>
      <div class="ho2-ico">${iconHtml(recipe.result?.id, recipe.result?.name)}</div>
      <div>
        <div class="ho2-name">${esc(recipe.result?.name || id)}</div>
        <div class="ho2-sub">${esc(recipe.benchName)} · ${esc(recipe.category)} · ${esc(perkText(recipe))}</div>
      </div>
      <span class="ho2-badge ${st.cls}">${st.t}</span>
    </div>
    <div class="ho2-recipe-line">
      ${chips}
      <span class="ho2-plus">→</span>
      <div class="ho2-chip out">
        <div class="ho2-chip-ico">${iconHtml(recipe.result?.id, recipe.result?.name)}</div>
        <div class="ho2-chip-q">${c.outQty}×</div>
        <div class="ho2-chip-n">${esc(recipe.result?.name || id)}</div>
      </div>
    </div>
    <div class="ho2-modal-ctrl">
      <label>Крафтов <input id="hoCrafts" value="${crafts}" inputmode="numeric"></label>
      <label>Цена продажи/шт <input id="hoSell" value="${state.manualPrice[outId] ?? (c.sellUnit != null ? c.sellUnit : "")}" placeholder="авто" inputmode="decimal"></label>
    </div>
    <div class="ho2-modal-stats">
      <div><span>Себестоимость</span><b>${fmtMoney(c.buyCost)}</b></div>
      <div><span>Выручка</span><b>${fmtMoney(c.gross)}</b></div>
      <div><span>Комиссия 5%</span><b>${fmtMoney(c.fee)}</b></div>
      <div><span>Прибыль</span><b class="${c.profit > 0 ? "pos" : c.profit < 0 ? "neg" : ""}">${fmtMoney(c.profit)}</b></div>
      <div><span>ROI</span><b>${c.roi === Infinity ? "∞" : c.roi != null ? c.roi + "%" : "—"}</b></div>
    </div>
    <div class="table-scroll"><table class="ho2-table">
      <thead><tr><th>Ресурс</th><th>Нужно</th><th>Есть</th><th>Купить</th><th>Цена</th><th>Сумма</th></tr></thead>
      <tbody>${lines}</tbody>
    </table></div>
  </div>`;

  document.getElementById("hoClose").onclick = (e) => {
    e.stopPropagation();
    close();
  };
  document.getElementById("hoCrafts").oninput = (e) => {
    state.crafts[id] = Math.max(1, Math.floor(Number(String(e.target.value).replace(/\s/g, "")) || 1));
    save();
    openModal(id);
  };
  document.getElementById("hoSell").oninput = (e) => {
    if (!outId) return;
    const raw = e.target.value.trim();
    if (raw === "") delete state.manualPrice[outId];
    else state.manualPrice[outId] = raw;
    save();
    openModal(id);
  };
  overlay.querySelectorAll("[data-stock]").forEach((inp) => {
    inp.oninput = () => {
      const v = String(inp.value).replace(/\s/g, "");
      if (v === "") delete state.stock[inp.dataset.stock];
      else state.stock[inp.dataset.stock] = Number(v) || 0;
      save();
      openModal(id);
    };
  });
  overlay.querySelectorAll("[data-price]").forEach((inp) => {
    inp.oninput = () => {
      const raw = inp.value.trim();
      if (raw === "") delete state.manualPrice[inp.dataset.price];
      else state.manualPrice[inp.dataset.price] = raw;
      save();
      openModal(id);
    };
  });
}

function fillCats() {
  const sel = document.getElementById("hoCat");
  if (!sel) return;
  const cur = state.cat || "";
  const cats = [...new Set(recipes.map((r) => r.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "ru")
  );
  sel.innerHTML =
    `<option value="">любая</option>` +
    cats.map((c) => `<option value="${esc(c)}"${c === cur ? " selected" : ""}>${esc(c)}</option>`).join("");
}

async function renderHideout() {
  const st = document.getElementById("hoStatus");
  if (st) st.textContent = "Загрузка…";
  try {
    try {
      if (typeof rows !== "undefined") window.rows = rows;
    } catch {}
    await loadRecipes();
    if (!recipes.length) {
      if (st) st.textContent = "Рецепты не загрузились";
      const g = document.getElementById("hoGrid");
      if (g) g.innerHTML = `<div class="empty">Нет hideout_recipes.json</div>`;
      return;
    }
    if (st) st.textContent = "Цены…";
    await loadPrices();
    fillCats();

    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v ?? "";
    };
    setVal("hoQ", state.q);
    setVal("hoHas", state.has);
    setVal("hoBench", state.bench);
    setVal("hoCat", state.cat);
    setVal("hoSort", state.sort);
    setVal("hoMinProfit", state.minProfit);
    setVal("hoMinRoi", state.minRoi);
    setVal("hoBudget", state.budget);

    const list = filtered();
    if (st) st.textContent = `Рецептов: ${list.length} / ${recipes.length} · цен в кэше: ${Object.keys(priceMap).length}`;
    const up = document.getElementById("hoUpdated");
    if (up) up.textContent = "цены: лоты + продажи из БД";

    renderHero(list);
    renderList(list);

    if (state.selected) openModal(state.selected);
    else {
      const ov = document.getElementById("hoOverlay");
      if (ov) {
        ov.style.display = "none";
        document.body.classList.remove("ho-modal-open");
      }
    }
  } catch (e) {
    console.error(e);
    if (st) st.textContent = "Ошибка: " + (e.message || e);
  }
}

function bindOnce() {
  if (window._ho2bound) return;
  window._ho2bound = true;
  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };
  const refresh = () => {
    save();
    renderHideout();
  };
  on("hoQ", "input", () => {
    clearTimeout(window._ho2q);
    window._ho2q = setTimeout(() => {
      state.q = document.getElementById("hoQ")?.value || "";
      refresh();
    }, 150);
  });
  on("hoHas", "input", () => {
    clearTimeout(window._ho2h);
    window._ho2h = setTimeout(() => {
      state.has = document.getElementById("hoHas")?.value || "";
      refresh();
    }, 150);
  });
  on("hoBench", "change", () => {
    state.bench = document.getElementById("hoBench").value;
    refresh();
  });
  on("hoCat", "change", () => {
    state.cat = document.getElementById("hoCat").value;
    refresh();
  });
  on("hoSort", "change", () => {
    state.sort = document.getElementById("hoSort").value;
    refresh();
  });
  on("hoMinProfit", "change", () => {
    state.minProfit = document.getElementById("hoMinProfit").value;
    refresh();
  });
  on("hoMinRoi", "change", () => {
    state.minRoi = document.getElementById("hoMinRoi").value;
    refresh();
  });
  on("hoBudget", "change", () => {
    state.budget = document.getElementById("hoBudget").value;
    refresh();
  });
  on("hoRefresh", "click", async () => {
    priceAt = 0;
    await loadPrices();
    renderHideout();
  });
  on("hoReset", "click", () => {
    state.q = "";
    state.has = "";
    state.bench = "";
    state.cat = "";
    state.minProfit = "";
    state.minRoi = "";
    state.budget = "";
    refresh();
  });
}

window.renderHideout = renderHideout;
window.hoBindOnce = bindOnce;
