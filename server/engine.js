import path from "node:path";
import fs from "node:fs";
import express from "express";
import {
  PORT, REGION, API, ID, SECRET, POLL_MS, CONCURRENCY, BATCH_DELAY_MS,
  MAX_ITEMS_PER_CYCLE, DATA_DIR, PUBLIC_DIR, ICONS_DIR,
  ALWAYS_PRIORITY, FALLBACK_ITEMS, sleep,
} from "./config.js";
import { DB, walCheckpoint } from "./db.js";
import { ipWhitelist } from "./middleware.js";
import { sseHandler, broadcastMarket, broadcastStatus, sseClientCount } from "./sse.js";

const app = express();

// Railway runs behind a reverse proxy. Trust the first proxy so Express
// resolves req.ip from X-Forwarded-For correctly.
app.set("trust proxy", 1);

let token = null, tokenExp = 0, scanning = false, scanCursor = 0, lastScan = null, lastError = null;
let apiBackoffUntil = 0;
let apiFailStreak = 0;
let currentPollMs = POLL_MS; // adaptive
const liveBusy = new Set(); // item ids currently being live-fetched by UI

/** Auction fee (known game rule, used across calc/deals UI). */
const AUCTION_FEE = 0.05;

/**
 * Robust market estimate from real sales.
 * - Matches rarity (qlt) and sharpening (ptn) when provided (critical for artefacts)
 * - Prefers fresh sales (24h → 72h → 7d → older)
 * - Drops outliers via IQR
 * - Uses median of cleaned sample (never a single max sale)
 */
function marketRefFromLast5Sales(itemId, qlt, ptn){
  return estimateMarketDeal(itemId, qlt, ptn);
}

function estimateMarketDeal(itemId, qlt, ptn){
  let saleGroup = [];
  try {
    // Pull a wider window; filter quality in JS for correct NULL matching
    saleGroup = DB.prepare(`
      SELECT price, amount, ts, qlt, ptn FROM sale_observations
      WHERE item_id=? AND price>0
      ORDER BY datetime(ts) DESC LIMIT 80
    `).all(itemId);
  } catch { saleGroup = []; }

  // Strict: same rarity (qlt) AND same sharpening (ptn). Never mix +0 with +3 etc.
  const wantQ = qlt != null ? Number(qlt) : null;
  const wantP = ptn != null && ptn !== "" ? Number(ptn) : null;
  saleGroup = saleGroup.filter(s => {
    const sq = s.qlt != null ? Number(s.qlt) : null;
    const sp = s.ptn != null ? Number(s.ptn) : 0;
    if (wantQ != null && sq !== wantQ) return false;
    if (wantP != null) {
      const wp = Number(wantP) || 0;
      if (sp !== wp) return false;
    }
    return Number(s.price) > 0;
  });

  const now = Date.now();
  const withTs = saleGroup.map(s => {
    const t = s.ts ? new Date(s.ts).getTime() : NaN;
    return { price: Number(s.price), ts: Number.isFinite(t) ? t : 0, ageH: Number.isFinite(t) ? (now - t) / 3600000 : 9999 };
  }).filter(s => s.price > 0);

  // Prefer fresher windows
  function pickWindow(maxAgeH, minNeed) {
    const w = withTs.filter(s => s.ageH <= maxAgeH);
    return w.length >= minNeed ? w : null;
  }
  let sample = pickWindow(24, 3) || pickWindow(72, 3) || pickWindow(24 * 7, 4) || (withTs.length ? withTs.slice(0, 20) : []);
  if (!sample.length) {
    return {
      ref: null, refSource: "none", refCount: 0, dataOk: false,
      confidence: "none", confidenceLabel: "Нет данных",
      saleMin: null, saleMax: null, saleMedian: null, saleAvg: null,
      windowHours: null, outlierDropped: 0, feeRate: AUCTION_FEE,
    };
  }

  // Cap to 25 most recent in chosen window
  sample = sample.slice(0, 25);
  const rawPrices = sample.map(s => s.price).sort((a, b) => a - b);

  // IQR outlier filter (need ≥5 points)
  let cleaned = rawPrices;
  let outlierDropped = 0;
  if (rawPrices.length >= 5) {
    const q1 = rawPrices[Math.floor((rawPrices.length - 1) * 0.25)];
    const q3 = rawPrices[Math.floor((rawPrices.length - 1) * 0.75)];
    const iqr = Math.max(0, q3 - q1);
    const lo = q1 - 1.5 * iqr;
    const hi = q3 + 1.5 * iqr;
    const filtered = rawPrices.filter(p => p >= lo && p <= hi);
    if (filtered.length >= 3) {
      outlierDropped = rawPrices.length - filtered.length;
      cleaned = filtered;
    }
  }

  const ref = medianOf(cleaned);
  const saleMin = cleaned[0];
  const saleMax = cleaned[cleaned.length - 1];
  const saleAvg = avgOf(cleaned);
  const maxAge = Math.max(...sample.map(s => s.ageH));
  const windowHours = Math.ceil(maxAge);
  const n = cleaned.length;

  // Spread relative to median
  const spread = ref > 0 && saleMax != null && saleMin != null
    ? (saleMax - saleMin) / ref
    : 1;

  // Confidence: count + freshness + low spread
  const freshCount = sample.filter(s => s.ageH <= 24).length;
  let confidence = "low";
  let confidenceLabel = "Низкая уверенность";
  if (n >= 8 && freshCount >= 4 && spread <= 0.35) {
    confidence = "high";
    confidenceLabel = "Высокая уверенность";
  } else if (n >= 5 && (freshCount >= 2 || maxAge <= 72) && spread <= 0.55) {
    confidence = "mid";
    confidenceLabel = "Средняя уверенность";
  } else if (n >= 3) {
    confidence = "low";
    confidenceLabel = "Низкая уверенность";
  } else {
    confidence = "low";
    confidenceLabel = "Мало продаж";
  }

  // dataOk: enough points after cleaning for a stable median
  const dataOk = n >= 3 && ref != null && ref > 0;

  let refSource = "sales_median";
  if (maxAge <= 24) refSource = "sales_24h_median";
  else if (maxAge <= 72) refSource = "sales_72h_median";
  else if (maxAge <= 24 * 7) refSource = "sales_7d_median";
  else refSource = "sales_older_median";

  return {
    ref,
    refSource,
    refCount: n,
    dataOk,
    confidence,
    confidenceLabel,
    saleMin,
    saleMax,
    saleMedian: ref,
    saleAvg,
    windowHours,
    outlierDropped,
    feeRate: AUCTION_FEE,
    freshCount,
  };
}

/** Net proceeds after auction fee when selling at expected price */
function netAfterFee(gross, feeRate = AUCTION_FEE) {
  if (gross == null || !(gross > 0)) return null;
  return Math.round(gross * (1 - feeRate));
}


let marketCache = { at: 0, rows: null, updated: null };
const MARKET_CACHE_MS = 2500;

async function getToken(){
  if(token && Date.now() < tokenExp - 30000) return token;
  if(!ID || !SECRET) throw new Error("STALZONE_CLIENT_ID / STALZONE_CLIENT_SECRET not configured");
  const body = new URLSearchParams({grant_type:"client_credentials",client_id:ID,client_secret:SECRET});
  let lastErr;
  for(let attempt=0; attempt<3; attempt++){
    try{
      const r = await fetch("https://exbo.net/oauth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
      const j = await r.json().catch(()=>({}));
      if(!r.ok || !j.access_token) throw new Error(`OAuth ${r.status}: ${JSON.stringify(j)}`);
      token=j.access_token; tokenExp=Date.now()+Number(j.expires_in||3600)*1000;
      return token;
    }catch(e){
      lastErr=e;
      await sleep(500 * (attempt+1));
    }
  }
  throw lastErr || new Error("OAuth failed");
}

async function api(apiPath){
  const now=Date.now();
  if(now < apiBackoffUntil){
    await sleep(Math.min(apiBackoffUntil - now, 8000));
  }
  let lastErr;
  for(let attempt=0; attempt<3; attempt++){
    try{
      const t=await getToken();
      const r=await fetch(`${API}/${REGION}${apiPath}`,{headers:{Authorization:`Bearer ${t}`,Accept:"application/json"}});
      const txt=await r.text();
      let j; try{j=JSON.parse(txt)}catch{j={raw:txt}};
      if(r.status===429 || r.status===503){
        const wait=Math.min(30000, 1000 * Math.pow(2, attempt+apiFailStreak));
        apiFailStreak=Math.min(8, apiFailStreak+1);
        apiBackoffUntil=Date.now()+wait;
        lastErr=new Error(`API ${r.status}: rate limited`);
        await sleep(wait);
        continue;
      }
      if(!r.ok) throw new Error(`API ${r.status}: ${txt.slice(0,400)}`);
      apiFailStreak=Math.max(0, apiFailStreak-1);
      if(apiFailStreak===0) apiBackoffUntil=0;
      return j;
    }catch(e){
      lastErr=e;
      if(String(e.message||"").includes("API 4") && !String(e.message).includes("429")) break;
      await sleep(300 * (attempt+1));
    }
  }
  throw lastErr || new Error("API failed");
}

async function fetchListingFromSources(){
  const sources = [
    "https://cdn.stalcraft.wiki/exbo_item_parser/listing.json",
    "https://raw.githubusercontent.com/StalcraftHQ/CustomItems/master/listing.json",
  ];
  const byId = new Map();
  for (const url of sources) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) { console.warn("listing source fail", url, r.status); continue; }
      let text = await r.text();
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM
      const list = JSON.parse(text);
      if (!Array.isArray(list)) continue;
      for (const x of list) {
        const id = x?.id || x?.itemId || x?.item_id;
        if (!id) continue;
        const nameObj = x.name;
        let name;
        if (typeof nameObj === "string") name = nameObj;
        else if (nameObj && typeof nameObj === "object") name = nameObj.ru || nameObj.en || nameObj.lines?.ru || nameObj.lines?.en;
        else name = x.title || id;
        const category = x.category || x.cat || "other";
        const rarity = x.color || x.rarity || "";
        if (!byId.has(id) || (name && name !== id)) {
          byId.set(String(id), { id: String(id), name: String(name || id), category: String(category), rarity: String(rarity) });
        }
      }
      console.log(`listing source ok: ${url} → ${list.length} rows`);
    } catch (e) {
      console.warn("listing source error", url, e.message);
    }
  }
  // Official GitHub: pull names for known priority ids if still missing
  for (const id of Object.keys(FALLBACK_ITEMS).concat(ALWAYS_PRIORITY)) {
    if (byId.has(id)) continue;
    for (const path of [
      `ru/items/other/${id}.json`,
      `ru/items/misc/${id}.json`,
      `global/items/other/${id}.json`,
    ]) {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/EXBO-Studio/stalzone-database/main/${path}`);
        if (!r.ok) continue;
        const j = await r.json();
        const name = j?.name?.lines?.ru || j?.name?.lines?.en || j?.name?.ru || j?.name?.en || FALLBACK_ITEMS[id]?.name || id;
        const category = j?.category || FALLBACK_ITEMS[id]?.category || "other";
        byId.set(id, { id, name: String(name), category: String(category), rarity: j?.color || "" });
        break;
      } catch {}
    }
  }
  return [...byId.values()];
}

function loadLocalCatalog(){
  const candidates = [
    path.join(PUBLIC_DIR, "..", "items_catalog.json"),
    path.join(PUBLIC_DIR, "items_catalog.json"),
    path.join(DATA_DIR, "items_catalog.json"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const list = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
      if (Array.isArray(list) && list.length) {
        console.log(`Local catalog loaded: ${p} (${list.length})`);
        return list.map(x => ({
          id: String(x.id || ""),
          name: String(x.name || x.id || ""),
          category: String(x.category || ""),
          rarity: String(x.rarity || x.color || ""),
        })).filter(x => x.id);
      }
    } catch (e) {
      console.warn("local catalog skip", p, e.message);
    }
  }
  return [];
}

async function fetchGithubItemIds(){
  try {
    const r = await fetch("https://api.github.com/repos/EXBO-Studio/stalzone-database/git/trees/main?recursive=1", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "stalzone-market-monitor" },
    });
    if (!r.ok) { console.warn("github tree", r.status); return []; }
    const j = await r.json();
    const out = [];
    for (const t of (j.tree || [])) {
      const p = t.path || "";
      if (!p.startsWith("ru/items/") || !p.endsWith(".json") || p.includes("/_variants/") || t.type !== "blob") continue;
      const id = p.slice(p.lastIndexOf("/") + 1, -5);
      if (!id || id.startsWith("_")) continue;
      const parts = p.split("/");
      const category = parts.slice(2, -1).join("/");
      out.push({ id, name: id, category, rarity: "" });
    }
    console.log(`GitHub tree ids: ${out.length}`);
    return out;
  } catch (e) {
    console.warn("github tree error", e.message);
    return [];
  }
}

async function syncItems(){
  console.log("Syncing items from multiple sources ...");
  const byId = new Map();
  const add = (rows) => {
    for (const x of rows || []) {
      if (!x?.id) continue;
      const id = String(x.id);
      const prev = byId.get(id);
      const name = String(x.name || id);
      // Prefer human names over bare ids
      if (!prev || (prev.name === prev.id && name !== id) || (name && name !== id && prev.name === id)) {
        byId.set(id, {
          id,
          name: name || id,
          category: String(x.category || prev?.category || ""),
          rarity: String(x.rarity || x.color || prev?.rarity || ""),
        });
      } else if (prev && !prev.category && x.category) {
        prev.category = String(x.category);
      }
    }
  };

  // 1) Local snapshot (full catalog shipped with app)
  add(loadLocalCatalog());
  // 2) Live listing.json mirrors
  add(await fetchListingFromSources());
  // 3) Official GitHub tree (all base item ids)
  add(await fetchGithubItemIds());
  // 4) Hard fallback trade goods (season pass etc. — not always in GitHub tree)
  add(Object.entries(FALLBACK_ITEMS).map(([id, meta]) => ({ id, name: meta.name, category: meta.category, rarity: "" })));

  const list = [...byId.values()];
  if (!list.length) throw new Error("No items from any listing source");

  const ins = DB.prepare(`INSERT INTO items(id,name,category,rarity,icon) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, rarity=excluded.rarity`);
  const tx = DB.transaction((rows) => {
    for (const x of rows) {
      ins.run(x.id, x.name || x.id, x.category || "", x.rarity || "", null);
    }
  });
  tx(list);

  // Re-seed priority every sync
  try {
    const ups = DB.prepare("INSERT INTO priority_items(id,weight,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at");
    const now = new Date().toISOString();
    for (const id of ALWAYS_PRIORITY) ups.run(id, 80, now);
  } catch (e) { console.warn("priority reseed:", e.message); }

  const n = DB.prepare("SELECT count(*) n FROM items").get().n;
  DB.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('items_synced_at',?)").run(new Date().toISOString());
  console.log(`Items synced: ${n} (local+listing+github+fallback)`);
  // Log critical items presence
  for (const id of ["8AjTFOVB", "cpe1d8xz", "kJD59qaP", "rdt1m5ve"]) {
    const row = DB.prepare("SELECT id,name FROM items WHERE id=?").get(id);
    console.log(`  critical ${id}:`, row ? row.name : "MISSING");
  }
}

function parseLots(j){
  const arr=Array.isArray(j)?j:(j.lots||j.data||[]);
  return arr.map((x,i)=>{
    const amount=Math.max(1, Number(x.amount ?? x.quantity ?? 1));
    const total=Number(x.price ?? x.buyoutPrice ?? x.currentPrice ?? 0);
    const unit=total>0?Math.round(total/amount):0;
    const add=x.additional||{};
    const qlt=add.qlt!=null?Number(add.qlt):null;
    const ptn=add.ptn!=null?Number(add.ptn):(add.upgrade_bonus!=null?Number(add.upgrade_bonus):null);
    return {
      id:String(x.id ?? x.lotId ?? x.uuid ?? `${x.startTime||x.createdAt||i}-${total}-${qlt}-${ptn}`),
      price:unit,
      totalPrice:total,
      amount,
      qlt, ptn,
      created:x.startTime||x.createdAt||x.timeCreated||new Date().toISOString(),
      raw:JSON.stringify(x)
    };
  }).filter(x=>x.price>0);
}
function parseHistory(j){
  const arr=Array.isArray(j)?j:(j.prices||j.history||j.sales||j.data||[]);
  return arr.map((x,i)=>{
    const amount=Math.max(1, Number(x.amount ?? x.quantity ?? 1));
    const total=Number(x.price ?? x.buyoutPrice ?? 0);
    const unit=total>0?Math.round(total/amount):0;
    const add=x.additional||{};
    const qlt=add.qlt!=null?Number(add.qlt):null;
    const ptn=add.ptn!=null?Number(add.ptn):(add.upgrade_bonus!=null?Number(add.upgrade_bonus):null);
    return {
      id:String(x.id ?? x.lotId ?? x.uuid ?? `${x.time||x.sellTime||x.createdAt||i}-${total}-${qlt}-${ptn}`),
      ts:x.time||x.sellTime||x.createdAt||x.timestamp||null,
      price:unit,
      totalPrice:total,
      amount, qlt, ptn,
      raw:JSON.stringify(x)
    };
  }).filter(x=>x.price>0);
}
const QLT_LABELS={0:"Обычное",1:"Необычное",2:"Особое",3:"Редкое",4:"Исключительное",5:"Легендарное",6:"Уникальное"};
const QLT_SHORT={0:"серый",1:"зелён",2:"синий",3:"фиол",4:"красн",5:"желт",6:"уникал"};
const QLT_COLOR={0:"#9ca3af",1:"#4ade80",2:"#60a5fa",3:"#c084fc",4:"#f87171",5:"#fbbf24",6:"#ff2a2a"};
function qltLabel(q){return q!=null && QLT_LABELS[q]!=null?QLT_LABELS[q]:null;}
function qltShort(q){return q!=null && QLT_SHORT[q]!=null?QLT_SHORT[q]:null;}
/** Parse virtual id "5logg@q2" or "5logg@q2p3" → {baseId, qlt, ptn} */
function parseVariantId(raw){
  const s=String(raw||"");
  const m=s.match(/^(.*)@q(\d+)(?:p(\d+))?$/);
  if(m) return {
    baseId: m[1],
    qlt: Number(m[2]),
    ptn: m[3] != null ? Number(m[3]) : null,
    variantId: s,
  };
  return { baseId: s, qlt: null, ptn: null, variantId: s };
}
function makeVariantId(baseId, qlt, ptn){
  let id = `${baseId}@q${qlt}`;
  const p = ptn != null ? Number(ptn) : 0;
  if (p > 0) id += `p${p}`;
  return id;
}
function variantDisplayName(baseName, qlt){
  // Без названия цвета в имени — цвет только через rarity/qltColor в UI
  let base=baseName||"";
  if(/странн(ый)?\s*арт/i.test(base) || /strange\s*artifact/i.test(base)) base="Стран Арт";
  return base;
}




async function fetchAllLots(itemId){
  const pageSize=200;
  const maxPages=1000;
  const all=[];
  const seen=new Set();
  let offset=0;
  let total=null;

  for(let page=0; page<maxPages; page++){
    const j=await api(`/auction/${encodeURIComponent(itemId)}/lots?offset=${offset}&limit=${pageSize}&sort=buyout_price&order=asc&additional=true`);
    const rawArr=Array.isArray(j)?j:(j?.lots||j?.data?.lots||j?.data||[]);
    if(!Array.isArray(rawArr)||!rawArr.length) break;
    if(total==null){
      const t=Number(j?.total ?? j?.data?.total ?? j?.totalCount ?? j?.count);
      if(Number.isFinite(t)&&t>=0) total=t;
    }
    const parsed=parseLots({lots:rawArr});
    let added=0;
    for(const lot of parsed){
      if(!seen.has(lot.id)){seen.add(lot.id);all.push(lot);added++;}
    }
    if(total!=null && seen.size>=total) break;
    if(rawArr.length<pageSize) break;
    if(added===0) break;
    offset+=rawArr.length;
    await sleep(35);
  }
  const now=Date.now();
  return all.filter(l=>{
    try{
      const raw=JSON.parse(l.raw||'{}');
      if(raw.endTime){const t=new Date(raw.endTime).getTime(); if(Number.isFinite(t)&&t<=now)return false;}
    }catch{}
    return true;
  });
}

function saveLots(itemId,lots,now=new Date().toISOString()){
  const ins=DB.prepare(`INSERT OR REPLACE INTO lots(item_id,lot_id,price,amount,created_at,raw,seen_at,qlt,ptn) VALUES(?,?,?,?,?,?,?,?,?)`);
  const getPrev=DB.prepare(`SELECT lot_id, seen_at, created_at FROM lots WHERE item_id=?`);
  const delMissing=DB.prepare(`DELETE FROM lots WHERE item_id=? AND lot_id NOT IN (SELECT value FROM json_each(?))`);
  const delAll=DB.prepare(`DELETE FROM lots WHERE item_id=?`);
  const tx=DB.transaction(a=>{
    if(!a.length){ delAll.run(itemId); return; }
    // Preserve seen_at for lots that already existed — only NEW lot_ids get "now".
    // Otherwise every scan bumps all rarities to the top together.
    const prevRows=getPrev.all(itemId);
    const prevSeen=new Map(prevRows.map(r=>[r.lot_id, r.seen_at]));
    const ids=a.map(x=>x.id);
    for(const x of a){
      const seen=prevSeen.has(x.id) ? (prevSeen.get(x.id)||now) : now;
      ins.run(itemId,x.id,x.price,x.amount,x.created,x.raw||JSON.stringify(x),seen,x.qlt,x.ptn);
    }
    try { delMissing.run(itemId, JSON.stringify(ids)); }
    catch {
      const keep=new Set(ids);
      const existing=DB.prepare("SELECT lot_id FROM lots WHERE item_id=?").all(itemId);
      const rm=DB.prepare("DELETE FROM lots WHERE item_id=? AND lot_id=?");
      for(const e of existing){ if(!keep.has(e.lot_id)) rm.run(itemId, e.lot_id); }
    }
  });
  tx(lots);
  const prices=lots.map(x=>x.price).filter(p=>p>0).sort((a,b)=>a-b);
  DB.prepare(`INSERT OR REPLACE INTO price_observations(item_id,ts,min_price,avg_price,max_price,lots,sales) VALUES(?,?,?,?,?,?,0)`)
    .run(itemId,now,prices[0]||null,prices.length?prices.reduce((a,b)=>a+b,0)/prices.length:null,prices.length?prices[prices.length-1]:null,lots.length);
  marketCache.at=0;
  return prices;
}

async function scanOne(item){
  const lots=await fetchAllLots(item.id);
  const now=new Date().toISOString();
  saveLots(item.id,lots,now);

  // Refresh sale history even when there are no active lots. A sold-out item
  // still has a fresh completed sale in the history endpoint.
  {
    try{
      const hj=await api(`/auction/${encodeURIComponent(item.id)}/history?limit=50&additional=true`);
      const sales=parseHistory(hj).map(s=>({...s, ts:s.ts||now, raw:s.raw||JSON.stringify(s)}));
      const sins=DB.prepare(`INSERT OR REPLACE INTO sale_observations(item_id,sale_id,ts,price,amount,raw,qlt,ptn) VALUES(?,?,?,?,?,?,?,?)`);
      const stx=DB.transaction(a=>{for(const s of a)sins.run(item.id,s.id,s.ts,s.price,s.amount,s.raw||JSON.stringify(s),s.qlt,s.ptn)});
      stx(sales);
    }catch{}
  }
}

async function mapPool(items, limit, fn){
  const ret=[];
  let i=0;
  async function worker(){
    while(i<items.length){
      const idx=i++;
      try{ ret[idx]=await fn(items[idx]); }
      catch(e){ ret[idx]=e; lastError=`${items[idx]?.name||items[idx]?.id}: ${e.message}`; }
    }
  }
  const workers=Array.from({length:Math.min(limit,items.length)},()=>worker());
  await Promise.all(workers);
  return ret;
}

async function scanCycle(){
  if(scanning)return;
  if(Date.now() < apiBackoffUntil) {
    console.log("Scan deferred: API backoff");
    return;
  }
  scanning=true; lastError=null;
  try{
    let all=DB.prepare("SELECT * FROM items").all();
    if(!all.length){ await syncItems(); all=DB.prepare("SELECT * FROM items").all(); }

    const priorityRows=DB.prepare("SELECT id, weight FROM priority_items").all();
    const prioMap=new Map(priorityRows.map(x=>[x.id, Number(x.weight)||1]));

    const hotIds=new Set(
      DB.prepare("SELECT DISTINCT item_id FROM lots").all().map(x=>x.item_id)
        .concat(DB.prepare("SELECT DISTINCT item_id FROM sale_observations WHERE ts >= datetime('now','-2 days')").all().map(x=>x.item_id))
    );

    // score: priority (client favs) > has lots/sales > rest; skip items currently live-fetched by UI last
    all.sort((a,b)=>{
      const ap=prioMap.has(a.id)?0:1;
      const bp=prioMap.has(b.id)?0:1;
      if(ap!==bp) return ap-bp;
      if(ap===0){
        const aw=prioMap.get(a.id)||0, bw=prioMap.get(b.id)||0;
        if(bw!==aw) return bw-aw;
      }
      const ah=hotIds.has(a.id)?0:1;
      const bh=hotIds.has(b.id)?0:1;
      if(ah!==bh) return ah-bh;
      const al=liveBusy.has(a.id)?1:0;
      const bl=liveBusy.has(b.id)?1:0;
      if(al!==bl) return al-bl;
      return (a.id||"").localeCompare(b.id||"");
    });

    // Always include top priority items first each cycle
    const selected=[];
    const seen=new Set();
    for(const id of [...prioMap.keys()].sort((a,b)=>(prioMap.get(b)||0)-(prioMap.get(a)||0))){
      const it=all.find(x=>x.id===id);
      if(it && !seen.has(id)){ selected.push(it); seen.add(id); }
      if(selected.length>=Math.min(40, MAX_ITEMS_PER_CYCLE)) break;
    }
    for(let k=0;k<all.length && selected.length<Math.min(MAX_ITEMS_PER_CYCLE,all.length);k++){
      const it=all[(scanCursor+k)%all.length];
      if(!seen.has(it.id)){ selected.push(it); seen.add(it.id); }
    }
    scanCursor=(scanCursor+Math.max(1, selected.length - Math.min(40, prioMap.size)))%Math.max(all.length,1);

    for(let i=0;i<selected.length;i+=CONCURRENCY){
      const batch=selected.slice(i,i+CONCURRENCY).filter(x=>!liveBusy.has(x.id));
      if(!batch.length) continue;
      await mapPool(batch, CONCURRENCY, scanOne);
      if(i+CONCURRENCY<selected.length) await sleep(BATCH_DELAY_MS);
    }
    lastScan=new Date().toISOString();
    // adaptive poll: slow down on errors, speed up when healthy
    if(apiFailStreak>=3) currentPollMs=Math.min(POLL_MS*3, 180000);
    else if(apiFailStreak>=1) currentPollMs=Math.min(POLL_MS*1.5, 90000);
    else currentPollMs=POLL_MS;
    marketCache.at=0;
    console.log(`Scan done: ${selected.length} items, cursor=${scanCursor}, poll=${currentPollMs}ms`);
    try {
      marketCache.at = 0;
      const { updated, rows } = getMarketRows(true);
      broadcastMarket({ updated, total: rows.length, at: Date.now() });
      broadcastStatus({
        scanning: false,
        lastScan,
        lastError,
        itemCount: DB.prepare("SELECT count(*) n FROM items").get().n,
        lotItems: DB.prepare("SELECT count(DISTINCT item_id) n FROM lots").get().n,
      });
    } catch (e) { console.warn("sse broadcast:", e.message); }
  }catch(e){
    lastError=e.message;
    apiFailStreak=Math.min(8, apiFailStreak+1);
    currentPollMs=Math.min(POLL_MS*2, 120000);
  }finally{scanning=false}
}

function avgOf(prices){
  if(!prices.length) return null;
  return Math.round(prices.reduce((a,b)=>a+b,0)/prices.length);
}
function medianOf(prices){
  if(!prices.length) return null;
  const s=[...prices].sort((a,b)=>a-b);
  return s[Math.floor(s.length/2)];
}
function dayStartISO(offsetDays=0){
  const d=new Date();
  d.setHours(0,0,0,0);
  d.setDate(d.getDate()+offsetDays);
  return d.toISOString();
}

function weightedPrices(rows){
  // expand by amount (cap expansion to avoid huge arrays)
  const out=[];
  for(const r of rows){
    const p=Number(r.price); if(!(p>0)) continue;
    const a=Math.min(Math.max(1, Number(r.amount||1)), 50);
    for(let i=0;i<a;i++) out.push(p);
  }
  return out;
}
function salesAverages(itemId){
  const sales=DB.prepare("SELECT price, amount, ts FROM sale_observations WHERE item_id=?").all(itemId);
  const startToday=new Date(); startToday.setHours(0,0,0,0);
  const startYesterday=new Date(startToday); startYesterday.setDate(startYesterday.getDate()-1);
  const startWeek=new Date(startToday); startWeek.setDate(startWeek.getDate()-7);

  const inRange=(s,from,to)=>{
    const t=new Date(s.ts);
    if(from && t<from) return false;
    if(to && t>=to) return false;
    return true;
  };
  const all=weightedPrices(sales);
  const week=weightedPrices(sales.filter(s=>inRange(s,startWeek,null)));
  const today=weightedPrices(sales.filter(s=>inRange(s,startToday,null)));
  const yesterday=weightedPrices(sales.filter(s=>inRange(s,startYesterday,startToday)));
  const allEvents=sales.filter(s=>s.price>0).length;
  const weekEvents=sales.filter(s=>s.price>0&&inRange(s,startWeek,null)).length;
  const todayEvents=sales.filter(s=>s.price>0&&inRange(s,startToday,null)).length;
  const yestEvents=sales.filter(s=>s.price>0&&inRange(s,startYesterday,startToday)).length;

  return {
    avgAll: avgOf(all),
    avg7d: avgOf(week),
    avgToday: avgOf(today),
    avgYesterday: avgOf(yesterday),
    medianAll: medianOf(all),
    median7d: medianOf(week),
    salesCount: allEvents,
    sales7d: weekEvents,
    salesToday: todayEvents,
    salesYesterday: yestEvents
  };
}

app.use(ipWhitelist);
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get("/api/stream", sseHandler);
app.get("/api/status",(_,res)=>res.json({
  ok:true,configured:!!(ID&&SECRET),region:REGION,scanning,lastScan,lastError,
  itemCount:DB.prepare("SELECT count(*) n FROM items").get().n,
  lotItems:DB.prepare("SELECT count(DISTINCT item_id) n FROM lots").get().n,
  observationCount:DB.prepare("SELECT count(*) n FROM price_observations").get().n,
  concurrency:CONCURRENCY,
  pollMs:currentPollMs,
  apiBackoffUntil:apiBackoffUntil||null,
  apiFailStreak,
  priorityCount:DB.prepare("SELECT count(*) n FROM priority_items").get().n,
  sseClients:sseClientCount()
}));

app.post("/api/items/sync",async(_,res)=>{
  try{await syncItems();res.json({ok:true,count:DB.prepare("SELECT count(*) n FROM items").get().n})}
  catch(e){res.status(500).json({ok:false,error:e.message})}
});

// Debug / catalog search — always returns DB items (incl. season pass without lots)
app.get("/api/items",(req,res)=>{
  try{
    const q=String(req.query.q||"").trim().toLowerCase();
    let rows;
    if(q){
      rows=DB.prepare("SELECT id,name,category,rarity FROM items WHERE lower(name) LIKE ? OR lower(id) LIKE ? ORDER BY name LIMIT 200")
        .all(`%${q}%`,`%${q}%`);
    }else{
      rows=DB.prepare("SELECT id,name,category,rarity FROM items ORDER BY name LIMIT 500").all();
    }
    res.json({ok:true,count:rows.length,total:DB.prepare("SELECT count(*) n FROM items").get().n,rows});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.post("/api/scan",async(_,res)=>{
  if(scanning)return res.json({ok:true,started:false,scanning:true});
  scanCycle().catch(e=>lastError=e.message);
  res.json({ok:true,started:true});
});

function buildMarketRow(x){
  const getLast=DB.prepare(`SELECT * FROM price_observations WHERE item_id=? ORDER BY ts DESC LIMIT 1`);
  const getLots=DB.prepare(`SELECT price, amount, qlt, ptn, created_at, seen_at FROM lots WHERE item_id=? ORDER BY price ASC`);
  const o=getLast.get(x.id);
  const lotRows=getLots.all(x.id);
  const lotsCount=lotRows.length;
  const totalAmount=lotRows.reduce((sum,l)=>sum+(Number(l.amount)||0),0);
  const lotPrices=lotRows.map(l=>l.price).filter(p=>p>0);
  const minLot=lotRows[0]||null;
  const minP=minLot?.price??(o?.min_price??null);
  const minQlt=minLot?.qlt??null;
  const minPtn=minLot?.ptn??null;
  const lotAvg=lotPrices.length?avgOf(lotPrices):(o?.avg_price??null);

  // Robust estimate from recent sales (rarity + sharpening aware)
  const mr=estimateMarketDeal(x.id, minQlt, minPtn);
  let ref=mr.ref, refSource=mr.refSource, refCount=mr.refCount, dataOk=mr.dataOk;
  if(!dataOk && minP!=null){
    ref=minP;
    refSource="min_lot";
    refCount=0;
  }

  const expectedNet = (dataOk && mr.ref!=null) ? netAfterFee(mr.ref, mr.feeRate) : null;
  const profit = (minP!=null && expectedNet!=null) ? Math.round(expectedNet - minP) : null;
  const profitPct = (minP && expectedNet!=null && minP>0) ? Math.round(((expectedNet - minP)/minP)*1000)/10 : null;

  let status="no_data", statusLabel="Мало данных";
  if(minP && dataOk && expectedNet!=null){
    const ratio = minP / mr.ref;
    if(profit!=null && profit>0 && ratio<=0.95){ status="cheap"; statusLabel="Выгодно"; }
    else if(ratio>=1.08){ status="expensive"; statusLabel="Дорого"; }
    else { status="normal"; statusLabel="Обычная"; }
  } else if(minP){ status="has_lots"; statusLabel="В продаже"; }
  const lastSaleRow=DB.prepare("SELECT price,ts,qlt,ptn FROM sale_observations WHERE item_id=? ORDER BY ts DESC LIMIT 1").get(x.id);
  const lastSale=lastSaleRow?.price??null;
  const changeVsLast=(minP&&lastSale)?Math.round(((minP-lastSale)/lastSale)*1000)/10:null;
  const sa=salesAverages(x.id);
  const soldPerDay=sa.sales7d!=null ? Math.round((sa.sales7d/7)*10)/10 : 0;

  return {
    ...x,
    min_price:minP,
    avg_price:lotAvg,
    max_price:lotPrices.length?lotPrices[lotPrices.length-1]:(o?.max_price??null),
    lots:lotsCount,
    totalAmount:totalAmount>0?totalAmount:null,
    minAmount:minLot?.amount??null,
    minTotalPrice:minLot?.price!=null && minLot?.amount!=null ? Math.round(minLot.price*minLot.amount) : null,
    minUnitPrice:minLot?.price??minP,
    minQlt, minPtn,
    qltLabel:qltLabel(minQlt),
    histMedian:ref,
    histSource:refSource,
    histCount:refCount,
    dataOk,
    confidence: mr.confidence || "none",
    confidenceLabel: mr.confidenceLabel || null,
    expectedSale: dataOk ? mr.ref : null,
    expectedNet: expectedNet,
    feeRate: mr.feeRate ?? AUCTION_FEE,
    feeAmount: (dataOk && mr.ref!=null) ? Math.round(mr.ref * (mr.feeRate ?? AUCTION_FEE)) : null,
    saleMin: mr.saleMin ?? null,
    saleMax: mr.saleMax ?? null,
    saleAvg: mr.saleAvg ?? null,
    windowHours: mr.windowHours ?? null,
    outlierDropped: mr.outlierDropped ?? 0,
    dealNote: dataOk
      ? (`На основе ${refCount} продаж` + (mr.windowHours!=null ? ` за ~${mr.windowHours}ч` : "") + (mr.outlierDropped ? ` (−${mr.outlierDropped} выброс.)` : ""))
      : (minP!=null ? "Мало продаж — без прогноза прибыли" : null),
    avgAll:sa.avgAll,
    avg7d:sa.avg7d,
    avgToday:sa.avgToday,
    avgYesterday:sa.avgYesterday,
    salesCount:sa.salesCount,
    sales7d:sa.sales7d,
    salesToday:sa.salesToday,
    salesYesterday:sa.salesYesterday,
    soldPerDay,
    lastSale,
    changeVsLast,
    status,statusLabel,
    profit,profitPct,
    ts: (()=>{
      // Prefer created_at (listing time) over seen_at so rescans don't bump all rarities
      let best=0, bestIso=null;
      for(const l of lotRows){
        const v=l.created_at || l.seen_at;
        if(!v) continue;
        const t=new Date(v).getTime();
        if(Number.isFinite(t) && t>best){ best=t; bestIso=typeof v==="string"?v:new Date(t).toISOString(); }
      }
      return bestIso || o?.ts || null;
    })()
  };
}

function buildVariantRow(baseItem, qlt, ptn, lotRowsForVariant, allLotRows){
  // One card = one rarity (qlt) + one sharpening (ptn); own lots + own sales history
  const fakeLots=lotRowsForVariant;
  const minLot=fakeLots[0]||null;
  const minP=minLot?.price??null;
  const minPtn=ptn!=null?Number(ptn):(minLot?.ptn!=null?Number(minLot.ptn):0);
  const lotPrices=fakeLots.map(l=>l.price).filter(p=>p>0);
  const lotAvg=lotPrices.length?avgOf(lotPrices):null;

  // Market estimate ONLY from sales with same qlt + same ptn
  const mr=estimateMarketDeal(baseItem.id, qlt, minPtn);
  let ref=mr.ref, refSource=mr.refSource, refCount=mr.refCount, dataOk=mr.dataOk;
  if(!dataOk && minP!=null){
    ref=minP;
    refSource="min_lot";
    refCount=0;
  }

  const expectedNet = (dataOk && mr.ref!=null) ? netAfterFee(mr.ref, mr.feeRate) : null;
  const profit = (minP!=null && expectedNet!=null) ? Math.round(expectedNet - minP) : null;
  const profitPct = (minP && expectedNet!=null && minP>0) ? Math.round(((expectedNet - minP)/minP)*1000)/10 : null;

  let status="no_data", statusLabel="Мало данных";
  if(minP && dataOk && expectedNet!=null){
    const ratio = minP / mr.ref;
    if(profit!=null && profit>0 && ratio<=0.95){ status="cheap"; statusLabel="Выгодно"; }
    else if(ratio>=1.08){ status="expensive"; statusLabel="Дорого"; }
    else { status="normal"; statusLabel="Обычная"; }
  } else if(minP){ status="has_lots"; statusLabel="В продаже"; }

  // Last sale for THIS variant only
  let lastSaleRow=null;
  try {
    lastSaleRow=DB.prepare(`
      SELECT price,ts FROM sale_observations
      WHERE item_id=? AND price>0
        AND (qlt IS ? OR (qlt IS NULL AND ? IS NULL))
        AND COALESCE(ptn,0)=?
      ORDER BY datetime(ts) DESC LIMIT 1
    `).get(baseItem.id, qlt, qlt, minPtn||0);
  } catch {
    lastSaleRow=DB.prepare("SELECT price,ts FROM sale_observations WHERE item_id=? AND (qlt IS ? OR (qlt IS NULL AND ? IS NULL)) ORDER BY ts DESC LIMIT 1").get(baseItem.id, qlt, qlt);
  }
  const lastSale=lastSaleRow?.price??null;
  const sa=salesAverages(baseItem.id);
  const totalAmount=fakeLots.reduce((s,l)=>s+(Number(l.amount)||0),0);
  const variantId=makeVariantId(baseItem.id, qlt, minPtn);
  const dispName=variantDisplayName(baseItem.name, qlt);

  return {
    ...baseItem,
    id: variantId,
    baseId: baseItem.id,
    name: dispName,
    variantQlt: qlt,
    variantPtn: minPtn||0,
    min_price: minP,
    avg_price: lotAvg,
    max_price: lotPrices.length?lotPrices[lotPrices.length-1]:null,
    lots: fakeLots.length,
    totalAmount: totalAmount>0?totalAmount:null,
    minAmount: minLot?.amount??null,
    minTotalPrice: minLot?.price!=null && minLot?.amount!=null ? Math.round(minLot.price*minLot.amount) : null,
    minUnitPrice: minLot?.price??minP,
    minQlt: qlt,
    minPtn,
    qltLabel: qltLabel(qlt),
    qltShort: qltShort(qlt),
    qltColor: QLT_COLOR[qlt]||null,
    histMedian: ref,
    histSource: refSource,
    histCount: refCount,
    dataOk,
    confidence: mr.confidence || "none",
    confidenceLabel: mr.confidenceLabel || null,
    expectedSale: dataOk ? mr.ref : null,
    expectedNet: expectedNet,
    feeRate: mr.feeRate ?? AUCTION_FEE,
    feeAmount: (dataOk && mr.ref!=null) ? Math.round(mr.ref * (mr.feeRate ?? AUCTION_FEE)) : null,
    saleMin: mr.saleMin ?? null,
    saleMax: mr.saleMax ?? null,
    saleAvg: mr.saleAvg ?? null,
    windowHours: mr.windowHours ?? null,
    outlierDropped: mr.outlierDropped ?? 0,
    dealNote: dataOk
      ? (`На основе ${refCount} продаж` + (mr.windowHours!=null ? ` за ~${mr.windowHours}ч` : "") + (mr.outlierDropped ? ` (−${mr.outlierDropped} выброс.)` : ""))
      : (minP!=null ? "Мало продаж — без прогноза прибыли" : null),
    avgAll: sa.avgAll, avg7d: sa.avg7d, avgToday: sa.avgToday, avgYesterday: sa.avgYesterday,
    salesCount: sa.salesCount, sales7d: sa.sales7d, salesToday: sa.salesToday, salesYesterday: sa.salesYesterday,
    soldPerDay: sa.sales7d!=null ? Math.round((sa.sales7d/7)*10)/10 : 0,
    lastSale,
    changeVsLast: (minP&&lastSale)?Math.round(((minP-lastSale)/lastSale)*1000)/10:null,
    status, statusLabel, profit, profitPct,
    // Per-rarity time: ONLY created_at of this qlt (listing time).
    // Rescan must not bump other rarities of the same item to the top.
    ts: (()=>{
      let best=0, bestIso=null;
      for(const l of fakeLots){
        const v=l.created_at || l.seen_at;
        if(!v) continue;
        const t=new Date(v).getTime();
        if(Number.isFinite(t) && t>best){ best=t; bestIso=typeof v==="string"?v:new Date(t).toISOString(); }
      }
      if(bestIso) return bestIso;
      try {
        const s=DB.prepare("SELECT MAX(created_at) AS ts FROM lots WHERE item_id=? AND qlt IS ?").get(baseItem.id, qlt);
        if(s?.ts) return s.ts;
      } catch {}
      return null;
    })(),
    isVariant: true
  };
}

function ensureCriticalItemsInDb(){
  const ins = DB.prepare(`INSERT INTO items(id,name,category,rarity,icon) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category`);
  for (const [id, meta] of Object.entries(FALLBACK_ITEMS)) {
    ins.run(id, meta.name, meta.category, "", null);
  }
  try {
    const ups = DB.prepare("INSERT INTO priority_items(id,weight,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at");
    const now = new Date().toISOString();
    for (const id of ALWAYS_PRIORITY) ups.run(id, 80, now);
  } catch {}
}

function getMarketRows(force=false){
  const now=Date.now();
  if(!force && marketCache.rows && (now-marketCache.at)<MARKET_CACHE_MS){
    return {updated:marketCache.updated||lastScan, rows:marketCache.rows};
  }
  // Guarantee season pass / protoartifact exist in DB every market build
  try { ensureCriticalItemsInDb(); } catch (e) { console.warn("ensureCritical", e.message); }

  const items=DB.prepare("SELECT * FROM items ORDER BY name").all();
  const getLots=DB.prepare(`SELECT price, amount, qlt, ptn, created_at, seen_at FROM lots WHERE item_id=? ORDER BY price ASC`);
  const prioIds=new Set(ALWAYS_PRIORITY);
  try {
    for (const r of DB.prepare("SELECT id FROM priority_items").all()) prioIds.add(r.id);
  } catch {}
  const rows=[];
  const seenIds=new Set();
  for(const x of items){
    seenIds.add(x.id);
    const lotRows=getLots.all(x.id);
    const isArtefact=/^artefact/i.test(String(x.category||"")) || /странн(ый)?\s*арт/i.test(x.name||"") || x.id==="5logg";
    // Group by rarity + sharpening: each (qlt, ptn) is a separate market
    const byVariant=new Map();
    for(const l of lotRows){
      const q=l.qlt!=null?Number(l.qlt):null;
      if(q==null) continue;
      const p=l.ptn!=null?Number(l.ptn):0;
      const key=q+":"+p;
      if(!byVariant.has(key)) byVariant.set(key, { qlt:q, ptn:p, lots:[] });
      byVariant.get(key).lots.push(l);
    }
    const expand = isArtefact || byVariant.size>=2;
    if(expand && byVariant.size>=1){
      const keys=[...byVariant.keys()].sort((a,b)=>{
        const [qa,pa]=a.split(":").map(Number);
        const [qb,pb]=b.split(":").map(Number);
        if(qa!==qb) return qa-qb;
        return pa-pb;
      });
      for(const key of keys){
        const g=byVariant.get(key);
        const row=buildVariantRow(x, g.qlt, g.ptn, g.lots, lotRows);
        row.priority=prioIds.has(x.id);
        rows.push(row);
      }
      const noQlt=lotRows.filter(l=>l.qlt==null);
      if(noQlt.length){
        const row=buildMarketRow(x);
        row.priority=prioIds.has(x.id);
        rows.push(row);
      }
    } else {
      const row=buildMarketRow(x);
      row.priority=prioIds.has(x.id);
      rows.push(row);
    }
  }
  // Inject any critical items missing from items table response
  for (const [id, meta] of Object.entries(FALLBACK_ITEMS)) {
    if (seenIds.has(id)) continue;
    const fake={ id, name: meta.name, category: meta.category, rarity: "", icon: null };
    const row=buildMarketRow(fake);
    row.priority=true;
    rows.push(row);
  }
  marketCache={at:now, rows, updated:lastScan};
  return {updated:lastScan, rows};
}

app.get("/api/market",(_,res)=>{
  try{
    const q=String(_.query.q||"").toLowerCase();
    let {updated, rows}=getMarketRows();
    if(q) rows=rows.filter(x=>(x.name||"").toLowerCase().includes(q)||(x.id||"").toLowerCase().includes(q));
    res.json({updated, rows});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});

// Lightweight delta: only rows changed since `since` (by observation ts or lot seen_at)
app.get("/api/market/delta",(req,res)=>{
  try{
    const since=String(req.query.since||"").trim();
    const {updated, rows}=getMarketRows();
    if(!since){
      return res.json({updated, full:true, rows});
    }
    const sinceT=new Date(since).getTime();
    if(!Number.isFinite(sinceT)){
      return res.json({updated, full:true, rows});
    }
    const changed=rows.filter(r=>{
      if(!r.ts) return (r.lots||0)>0;
      const t=new Date(r.ts).getTime();
      return Number.isFinite(t) && t>=sinceT-2000;
    });
    // also include items that lost all lots (were listed before)
    res.json({updated, full:false, since, rows:changed, total:rows.length});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});

// Client reports favorites / watched items for scan priority
app.post("/api/priority",(req,res)=>{
  try{
    const ids=Array.isArray(req.body?.ids)?req.body.ids:String(req.body?.ids||"").split(",");
    const weight=Math.max(1, Math.min(100, Number(req.body?.weight)||10));
    const now=new Date().toISOString();
    const ups=DB.prepare("INSERT INTO priority_items(id,weight,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at");
    const tx=DB.transaction(list=>{
      for(const raw of list){
        const id=String(raw||"").trim();
        if(!id || id.length>80) continue;
        ups.run(id, weight, now);
      }
    });
    tx(ids.slice(0,150));
    // prune stale priority older than 24h with low weight
    try{ DB.prepare("DELETE FROM priority_items WHERE updated_at < datetime('now','-1 day') AND weight < 20").run(); }catch{}
    res.json({ok:true, count:DB.prepare("SELECT count(*) n FROM priority_items").get().n});
  }catch(e){
    res.status(500).json({ok:false,error:e.message});
  }
});

app.get("/api/item/:id",async(req,res)=>{
  const {baseId, qlt, ptn}=parseVariantId(req.params.id);
  const item=DB.prepare("SELECT * FROM items WHERE id=?").get(baseId);
  if(!item)return res.status(404).json({error:"item not found"});
  if(qlt!=null){
    item.name=variantDisplayName(item.name, qlt);
    item.variantQlt=qlt;
    item.variantPtn=ptn!=null?Number(ptn):null;
    item.qltShort=qltShort(qlt);
    item.qltColor=QLT_COLOR[qlt];
  }
  // Opening an item performs a live refresh of active lots, so a purchased
  // lot disappears immediately instead of waiting for the background scanner.
  let lots=[];
  try{
    lots=await fetchAllLots(baseId);
    saveLots(baseId,lots,new Date().toISOString());
  }catch{
    lots=DB.prepare("SELECT * FROM lots WHERE item_id=? ORDER BY price ASC LIMIT 200").all(baseId);
  }
  if(qlt!=null){
    lots=lots.filter(l=>Number(l.qlt)===qlt);
    if(ptn!=null){
      const wp=Number(ptn)||0;
      lots=lots.filter(l=>(l.ptn!=null?Number(l.ptn):0)===wp);
    }
  }

  const observations=DB.prepare("SELECT * FROM price_observations WHERE item_id=? ORDER BY ts DESC LIMIT 2000").all(baseId).reverse();
  // Persistent history: save fresh sales, then always read the displayed history
  // from SQLite. A temporary empty API response never erases saved sales.
  try{
    const j=await api(`/auction/${encodeURIComponent(baseId)}/history?limit=200&additional=true`);
    const fresh=parseHistory(j)
      .filter(x=>x && x.price>0)
      .map(x=>({...x,ts:x.ts||new Date().toISOString(),raw:x.raw||JSON.stringify(x)}));
    if(fresh.length){
      const ins=DB.prepare(`INSERT OR REPLACE INTO sale_observations(item_id,sale_id,ts,price,amount,raw,qlt,ptn) VALUES(?,?,?,?,?,?,?,?)`);
      const tx=DB.transaction(a=>{
        for(const x of a)ins.run(baseId,x.id,x.ts,x.price,x.amount,x.raw,x.qlt,x.ptn);
      });
      tx(fresh);
    }
  }catch{}

  let history;
  if(qlt!=null){
    const wp = ptn!=null ? (Number(ptn)||0) : null;
    if(wp!=null){
      // Strict: same rarity + same sharpening only
      history=DB.prepare(
        `SELECT sale_id AS id,ts,price,amount,raw,qlt,ptn
         FROM sale_observations
         WHERE item_id=? AND price>0
           AND (qlt IS ? OR (qlt IS NULL AND ? IS NULL))
           AND COALESCE(ptn,0)=?
         ORDER BY datetime(ts) DESC LIMIT 500`
      ).all(baseId, qlt, qlt, wp);
    } else {
      history=DB.prepare(
        `SELECT sale_id AS id,ts,price,amount,raw,qlt,ptn
         FROM sale_observations
         WHERE item_id=? AND price>0 AND (qlt IS ? OR (qlt IS NULL AND ? IS NULL))
         ORDER BY datetime(ts) DESC LIMIT 500`
      ).all(baseId, qlt, qlt);
    }
  } else {
    history=DB.prepare(
      `SELECT sale_id AS id,ts,price,amount,raw,qlt,ptn
       FROM sale_observations
       WHERE item_id=? AND price>0
       ORDER BY datetime(ts) DESC LIMIT 500`
    ).all(baseId);
  }

  const sa=salesAverages(baseId);
  const salePrices=history.map(h=>h.price).filter(p=>p>0);
  const lastSale=history.find(h=>h.price>0)?.price??null;
  const curMin=lots.length?Math.min(...lots.map(l=>l.price)):null;
  const changeVsLastSale=(curMin&&lastSale)?Math.round(((curMin-lastSale)/lastSale)*1000)/10:null;

  res.json({
    item,observations,lots,history,
    stats:{
      ...sa,
      lastSale,
      curMin,
      changeVsLastSale,
      salesMedian:sa.medianAll,
      salesAvg:sa.avgAll
    }
  });
});



app.get("/api/item/:id/live",async(req,res)=>{
  const {baseId, qlt, ptn, variantId}=parseVariantId(req.params.id);
  liveBusy.add(baseId);
  try{
    let lots=await fetchAllLots(baseId);
    saveLots(baseId,lots,new Date().toISOString());
    if(qlt!=null) lots=lots.filter(l=>Number(l.qlt)===qlt);
    if(ptn!=null){ const wp=Number(ptn)||0; lots=lots.filter(l=>(l.ptn!=null?Number(l.ptn):0)===wp); }
    lots=lots.sort((a,b)=>(a.price||0)-(b.price||0));
    res.json({ok:true,id:variantId,baseId,variantQlt:qlt,lots:lots.map(x=>({...x,totalPrice:Math.round(x.price*x.amount),qlt:x.qlt,ptn:x.ptn,created_at:x.created})),lotsCount:lots.length,minPrice:lots[0]?.price??null,minUnitPrice:lots[0]?.price??null,minAmount:lots[0]?.amount??null,minTotalPrice:lots[0]?Math.round(lots[0].price*lots[0].amount):null,ts:new Date().toISOString()});
  }catch(e){
    let cached=DB.prepare("SELECT * FROM lots WHERE item_id=? ORDER BY price ASC").all(baseId);
    if(qlt!=null) cached=cached.filter(l=>Number(l.qlt)===qlt);
    if(ptn!=null){ const wp=Number(ptn)||0; cached=cached.filter(l=>(l.ptn!=null?Number(l.ptn):0)===wp); }
    res.json({ok:false,id:variantId,baseId,variantQlt:qlt,lots:cached.map(x=>({...x,totalPrice:Math.round(x.price*x.amount)})),lotsCount:cached.length,minPrice:cached[0]?.price??null,minUnitPrice:cached[0]?.price??null,minAmount:cached[0]?.amount??null,minTotalPrice:cached[0]?Math.round(cached[0].price*cached[0].amount):null,error:e.message});
  }finally{
    setTimeout(()=>liveBusy.delete(baseId), 2000);
  }
});

app.get("/api/favorites/live",async(req,res)=>{
  const ids=String(req.query.ids||"").split(",").map(x=>decodeURIComponent(x)).filter(Boolean).slice(0,100);
  const rows=[];
  for(const rawId of ids){
    const {baseId, qlt, ptn, variantId}=parseVariantId(rawId);
    try{
      const lotsAll=await fetchAllLots(baseId);
      saveLots(baseId,lotsAll,new Date().toISOString());
      let lots=lotsAll;
      if(qlt!=null) lots=lots.filter(l=>Number(l.qlt)===qlt);
      if(ptn!=null){ const wp=Number(ptn)||0; lots=lots.filter(l=>(l.ptn!=null?Number(l.ptn):0)===wp); }
      lots=lots.sort((a,b)=>(a.price||0)-(b.price||0));
      const item=DB.prepare("SELECT * FROM items WHERE id=?").get(baseId)||{id:baseId,name:baseId};
      const name=qlt!=null?variantDisplayName(item.name,qlt):item.name;
      let last;
      if(qlt!=null){
        const wp=ptn!=null?(Number(ptn)||0):null;
        if(wp!=null){
          last=DB.prepare("SELECT price,ts FROM sale_observations WHERE item_id=? AND (qlt IS ? OR (qlt IS NULL AND ? IS NULL)) AND COALESCE(ptn,0)=? ORDER BY datetime(ts) DESC LIMIT 1").get(baseId,qlt,qlt,wp);
        } else {
          last=DB.prepare("SELECT price,ts FROM sale_observations WHERE item_id=? AND (qlt IS ? OR (qlt IS NULL AND ? IS NULL)) ORDER BY datetime(ts) DESC LIMIT 1").get(baseId,qlt,qlt);
        }
      } else {
        last=DB.prepare("SELECT price,ts FROM sale_observations WHERE item_id=? ORDER BY datetime(ts) DESC LIMIT 1").get(baseId);
      }
      rows.push({ok:true,id:variantId,baseId,name,variantQlt:qlt,qltShort:qltShort(qlt),qltColor:qlt!=null?QLT_COLOR[qlt]:null,lotsCount:lots.length,minPrice:lots[0]?.price??null,minUnitPrice:lots[0]?.price??null,minAmount:lots[0]?.amount??null,minTotalPrice:lots[0]?Math.round(lots[0].price*lots[0].amount):null,lastSale:last?.price??null,ts:new Date().toISOString()});
    }catch(e){
      const item=DB.prepare("SELECT * FROM items WHERE id=?").get(baseId)||{id:baseId,name:baseId};
      let cached=DB.prepare("SELECT * FROM lots WHERE item_id=? ORDER BY price ASC").all(baseId);
      if(qlt!=null) cached=cached.filter(l=>Number(l.qlt)===qlt);
      const name=qlt!=null?variantDisplayName(item.name,qlt):item.name;
      const last=qlt!=null
        ? DB.prepare("SELECT price,ts FROM sale_observations WHERE item_id=? AND (qlt IS ? OR (qlt IS NULL AND ? IS NULL)) ORDER BY datetime(ts) DESC LIMIT 1").get(baseId,qlt,qlt)
        : DB.prepare("SELECT price,ts FROM sale_observations WHERE item_id=? ORDER BY datetime(ts) DESC LIMIT 1").get(baseId);
      rows.push({ok:false,id:variantId,baseId,name,variantQlt:qlt,lotsCount:cached.length,minPrice:cached[0]?.price??null,minUnitPrice:cached[0]?.price??null,minAmount:cached[0]?.amount??null,minTotalPrice:cached[0]?Math.round(cached[0].price*cached[0].amount):null,lastSale:last?.price??null,error:e.message});
    }
  }
  res.json({rows});
});

app.get("/api/icon/:id", async (req, res) => {
  const id = String(req.params.id || "").replace(/@q\d+$/,"").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return res.status(400).end();
  const local = path.join(ICONS_DIR, `${id}.png`);
  if (fs.existsSync(local) && fs.statSync(local).size > 50) {
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.sendFile(local);
  }
  const item = DB.prepare("SELECT category FROM items WHERE id=?").get(id);
  const cat = (item?.category || "other").replace(/\.\./g, "");
  const url = `https://raw.githubusercontent.com/EXBO-Studio/stalzone-database/main/ru/icons/${cat}/${id}.png`;
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(404).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf[0] !== 0x89) return res.status(404).end();
    fs.writeFileSync(local, buf);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(buf);
  } catch {
    return res.status(404).end();
  }
});



app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

export function startServer() {
  app.listen(PORT, () => console.log(`STALZONE Market Monitor: http://localhost:${PORT}`));

  (async () => {
    try {
      await syncItems();
      scanCycle().catch((e) => (lastError = e.message));
    } catch (e) {
      lastError = e.message;
    }
  })();

  (function scheduleScan() {
    setTimeout(async () => {
      try {
        await scanCycle();
      } catch (e) {
        lastError = e.message;
      }
      scheduleScan();
    }, Math.max(10000, currentPollMs || POLL_MS));
  })();

  setInterval(() => {
    walCheckpoint();
  }, 15 * 60 * 1000);
}

export { app, getMarketRows, syncItems, scanCycle };
