import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import dotenv from "dotenv";

dotenv.config();
const app = express();

// Railway runs behind a reverse proxy. Trust the first proxy so Express
// resolves req.ip from X-Forwarded-For correctly.
app.set("trust proxy", 1);

const IP_WHITELIST = new Set(
  (process.env.IP_WHITELIST || "")
    .split(",")
    .map(ip => ip.trim())
    .filter(Boolean)
);

function ipWhitelist(req, res, next) {
  const ip = req.ip;

  if (IP_WHITELIST.has(ip)) {
    return next();
  }

  console.log(`Blocked IP: ${ip}`);
  return res.status(403).send(`
    <!doctype html>
    <html>
      <head><meta charset="utf-8"><title>403</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:80px">
        <h1>403</h1>
        <p>Access denied</p>
      </body>
    </html>
  `);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const REGION = (process.env.STALZONE_REGION || "RU").toUpperCase();
const API = process.env.STALZONE_API_BASE || "https://eapi.stalzone.com";
const ID = process.env.STALZONE_CLIENT_ID;
const SECRET = process.env.STALZONE_CLIENT_SECRET;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 45000);
const CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 5);
const BATCH_DELAY_MS = Number(process.env.BATCH_DELAY_MS || 200);
const MAX_ITEMS_PER_CYCLE = Number(process.env.MAX_ITEMS_PER_CYCLE || 400);
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || (fs.existsSync("/app/data") ? "/app/data" : path.join(__dirname, "data"));
fs.mkdirSync(DATA_DIR,{recursive:true});
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "market.db");
const DB = new Database(DB_FILE);

DB.pragma("journal_mode = WAL");
DB.pragma("busy_timeout = 5000");
DB.pragma("synchronous = NORMAL");
DB.exec(`
CREATE TABLE IF NOT EXISTS items(
 id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, rarity TEXT, icon TEXT
);
CREATE TABLE IF NOT EXISTS lots(
 item_id TEXT, lot_id TEXT, price INTEGER, amount INTEGER, created_at TEXT,
 raw TEXT, seen_at TEXT, PRIMARY KEY(item_id,lot_id)
);
CREATE TABLE IF NOT EXISTS price_observations(
 item_id TEXT, ts TEXT, min_price INTEGER, avg_price REAL, max_price INTEGER, lots INTEGER, sales INTEGER,
 PRIMARY KEY(item_id,ts)
);
CREATE TABLE IF NOT EXISTS sale_observations(
 item_id TEXT, sale_id TEXT, ts TEXT, price INTEGER, amount INTEGER, raw TEXT,
 PRIMARY KEY(item_id,sale_id)
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS priority_items(
 id TEXT PRIMARY KEY, weight INTEGER NOT NULL DEFAULT 1, updated_at TEXT
);
`);

try { DB.exec("ALTER TABLE lots ADD COLUMN qlt INTEGER"); } catch {}
try { DB.exec("ALTER TABLE lots ADD COLUMN ptn INTEGER"); } catch {}
try { DB.exec("ALTER TABLE sale_observations ADD COLUMN qlt INTEGER"); } catch {}
try { DB.exec("ALTER TABLE sale_observations ADD COLUMN ptn INTEGER"); } catch {}

try {
  DB.exec("CREATE INDEX IF NOT EXISTS idx_lots_item_price ON lots(item_id, price)");
  DB.exec("CREATE INDEX IF NOT EXISTS idx_price_obs_item_ts ON price_observations(item_id, ts DESC)");
  DB.exec("CREATE INDEX IF NOT EXISTS idx_sale_obs_item_ts ON sale_observations(item_id, ts DESC)");
  DB.exec("CREATE INDEX IF NOT EXISTS idx_sale_obs_item_qlt ON sale_observations(item_id, qlt, ptn)");
} catch (e) { console.warn("index create:", e.message); }

let token = null, tokenExp = 0, scanning = false, scanCursor = 0, lastScan = null, lastError = null;
let apiBackoffUntil = 0;
let apiFailStreak = 0;
let currentPollMs = POLL_MS;
const liveBusy = new Set(); // item ids currently being live-fetched by UI

// Always-scan popular trade goods (incl. Протоартефакт)
const ALWAYS_PRIORITY = ["rdt1m5ve","55VrA59M","WdVYNOia","nb0OaSNs","rA8fsgH1","skuTyVhI","vKJbSN93","vpxznHgV"];
try {
  const ups = DB.prepare("INSERT INTO priority_items(id,weight,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET weight=excluded.weight, updated_at=excluded.updated_at");
  const now = new Date().toISOString();
  for (const id of ALWAYS_PRIORITY) ups.run(id, 50, now);
} catch (e) { console.warn("priority seed:", e.message); }

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

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

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

async function syncItems(){
  console.log("Syncing items from listing.json ...");
  const url = "https://cdn.stalcraft.wiki/exbo_item_parser/listing.json";
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`listing.json ${r.status}`);
  const list = await r.json();
  const ins = DB.prepare(`INSERT INTO items(id,name,category,rarity,icon) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, category=excluded.category, rarity=excluded.rarity`);
  const tx = DB.transaction((rows) => {
    for (const x of rows) {
      const id = x.id;
      if (!id) continue;
      const name = (x.name && (x.name.ru || x.name.en)) || id;
      const category = x.category || "";
      const rarity = x.color || x.rarity || "";
      ins.run(id, name, category, rarity, null);
    }
  });
  tx(list);
  const n = DB.prepare("SELECT count(*) n FROM items").get().n;
  DB.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('items_synced_at',?)").run(new Date().toISOString());
  console.log(`Items synced: ${n}`);
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
function qltLabel(q){return q!=null && QLT_LABELS[q]!=null?QLT_LABELS[q]:null;}



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
  const delMissing=DB.prepare(`DELETE FROM lots WHERE item_id=? AND lot_id NOT IN (SELECT value FROM json_each(?))`);
  const delAll=DB.prepare(`DELETE FROM lots WHERE item_id=?`);
  const tx=DB.transaction(a=>{
    if(!a.length){ delAll.run(itemId); return; }
    const ids=a.map(x=>x.id);
    for(const x of a)ins.run(itemId,x.id,x.price,x.amount,x.created,x.raw||JSON.stringify(x),now,x.qlt,x.ptn);
    // remove lots that disappeared
    try { delMissing.run(itemId, JSON.stringify(ids)); }
    catch {
      // fallback if json_each unavailable
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
  marketCache.at=0; // invalidate
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
app.use(express.static(path.join(__dirname,"public")));

app.get("/api/status",(_,res)=>res.json({
  ok:true,configured:!!(ID&&SECRET),region:REGION,scanning,lastScan,lastError,
  itemCount:DB.prepare("SELECT count(*) n FROM items").get().n,
  lotItems:DB.prepare("SELECT count(DISTINCT item_id) n FROM lots").get().n,
  observationCount:DB.prepare("SELECT count(*) n FROM price_observations").get().n,
  concurrency:CONCURRENCY,
  pollMs:currentPollMs,
  apiBackoffUntil:apiBackoffUntil||null,
  apiFailStreak,
  priorityCount:DB.prepare("SELECT count(*) n FROM priority_items").get().n
}));

app.post("/api/items/sync",async(_,res)=>{
  try{await syncItems();res.json({ok:true,count:DB.prepare("SELECT count(*) n FROM items").get().n})}
  catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.post("/api/scan",async(_,res)=>{
  if(scanning)return res.json({ok:true,started:false,scanning:true});
  scanCycle().catch(e=>lastError=e.message);
  res.json({ok:true,started:true});
});

function buildMarketRow(x){
  const getLast=DB.prepare(`SELECT * FROM price_observations WHERE item_id=? ORDER BY ts DESC LIMIT 1`);
  const getLots=DB.prepare(`SELECT price, amount, qlt, ptn FROM lots WHERE item_id=? ORDER BY price ASC`);
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
  const sameLots=lotRows.filter(l=>l.qlt===minQlt && l.ptn===minPtn).map(l=>l.price).filter(p=>p>0);

  let saleGroup=[];
  try {
    saleGroup=DB.prepare(`
      SELECT price, amount, ts
      FROM sale_observations
      WHERE item_id=?
        AND (qlt IS ? OR (qlt IS NULL AND ? IS NULL))
        AND (ptn IS ? OR (ptn IS NULL AND ? IS NULL))
        AND price>0
      ORDER BY datetime(ts) DESC
      LIMIT 20
    `).all(x.id, minQlt, minQlt, minPtn, minPtn);
  } catch { saleGroup=[]; }
  const salePrices=weightedPrices(saleGroup);

  let ref=null, refSource="none", refCount=0, dataOk=false;
  if(salePrices.length>=3){
    ref=medianOf(salePrices);
    refSource="recent_sales_20";
    refCount=saleGroup.length;
    dataOk=true;
  } else if(sameLots.length>=3){
    ref=medianOf(sameLots); refSource="lots_qlt_ptn"; refCount=sameLots.length; dataOk=true;
  } else if(sameLots.length>=1){
    ref=medianOf(sameLots); refSource="lots_qlt_ptn"; refCount=sameLots.length; dataOk=false;
  } else if(salePrices.length>=1){
    ref=medianOf(salePrices); refSource="sales_qlt_ptn"; refCount=saleGroup.length; dataOk=false;
  }

  let status="no_data", statusLabel="Мало данных";
  if(minP && ref && dataOk){
    const ratio=minP/ref;
    if(ratio<=0.92){ status="cheap"; statusLabel="Ниже рынка"; }
    else if(ratio>=1.10){ status="expensive"; statusLabel="Выше рынка"; }
    else { status="normal"; statusLabel="Обычная"; }
  } else if(minP && ref && !dataOk){
    const ratio=minP/ref;
    if(ratio<=0.85){ status="cheap"; statusLabel="Ниже рынка"; }
    else if(ratio>=1.20){ status="expensive"; statusLabel="Выше рынка"; }
    else if(minP){ status="has_lots"; statusLabel="В продаже"; }
  } else if(minP){ status="has_lots"; statusLabel="В продаже"; }

  const profit=(minP!=null && ref!=null)?Math.round(ref*0.95 - minP):null;
  const profitPct=(minP && ref && minP>0)?Math.round(((ref*0.95 - minP)/minP)*1000)/10:null;
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
    ts:o?.ts||null
  };
}

function getMarketRows(force=false){
  const now=Date.now();
  if(!force && marketCache.rows && (now-marketCache.at)<MARKET_CACHE_MS){
    return {updated:marketCache.updated||lastScan, rows:marketCache.rows};
  }
  const items=DB.prepare("SELECT * FROM items ORDER BY name").all();
  const rows=items.map(buildMarketRow);
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
  const item=DB.prepare("SELECT * FROM items WHERE id=?").get(req.params.id);
  if(!item)return res.status(404).json({error:"item not found"});
  // Opening an item performs a live refresh of active lots, so a purchased
  // lot disappears immediately instead of waiting for the background scanner.
  let lots=[];
  try{
    lots=await fetchAllLots(item.id);
    saveLots(item.id,lots,new Date().toISOString());
  }catch{
    lots=DB.prepare("SELECT * FROM lots WHERE item_id=? ORDER BY price ASC LIMIT 200").all(item.id);
  }

  const observations=DB.prepare("SELECT * FROM price_observations WHERE item_id=? ORDER BY ts DESC LIMIT 2000").all(item.id).reverse();
  // Persistent history: save fresh sales, then always read the displayed history
  // from SQLite. A temporary empty API response never erases saved sales.
  try{
    const j=await api(`/auction/${encodeURIComponent(item.id)}/history?limit=200&additional=true`);
    const fresh=parseHistory(j)
      .filter(x=>x && x.price>0)
      .map(x=>({...x,ts:x.ts||new Date().toISOString(),raw:x.raw||JSON.stringify(x)}));
    if(fresh.length){
      const ins=DB.prepare(`INSERT OR REPLACE INTO sale_observations(item_id,sale_id,ts,price,amount,raw,qlt,ptn) VALUES(?,?,?,?,?,?,?,?)`);
      const tx=DB.transaction(a=>{
        for(const x of a)ins.run(item.id,x.id,x.ts,x.price,x.amount,x.raw,x.qlt,x.ptn);
      });
      tx(fresh);
    }
  }catch{}

  let history=DB.prepare(
    `SELECT sale_id AS id,ts,price,amount,raw,qlt,ptn
     FROM sale_observations
     WHERE item_id=? AND price>0
     ORDER BY datetime(ts) DESC LIMIT 500`
  ).all(item.id);

  const sa=salesAverages(item.id);
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


const ICONS_DIR = path.join(__dirname, "public", "icons");
fs.mkdirSync(ICONS_DIR, { recursive: true });

app.get("/api/item/:id/live",async(req,res)=>{
  const id=String(req.params.id);
  liveBusy.add(id);
  try{
    const lots=await fetchAllLots(id);
    saveLots(id,lots,new Date().toISOString());
    res.json({ok:true,id,lots:lots.map(x=>({...x,totalPrice:Math.round(x.price*x.amount),qlt:x.qlt,ptn:x.ptn,created_at:x.created})),lotsCount:lots.length,minPrice:lots[0]?.price??null,minUnitPrice:lots[0]?.price??null,minAmount:lots[0]?.amount??null,minTotalPrice:lots[0]?Math.round(lots[0].price*lots[0].amount):null,ts:new Date().toISOString()});
  }catch(e){
    const cached=DB.prepare("SELECT * FROM lots WHERE item_id=? ORDER BY price ASC").all(id);
    res.json({ok:false,id,lots:cached.map(x=>({...x,totalPrice:Math.round(x.price*x.amount)})),lotsCount:cached.length,minPrice:cached[0]?.price??null,minUnitPrice:cached[0]?.price??null,minAmount:cached[0]?.amount??null,minTotalPrice:cached[0]?Math.round(cached[0].price*cached[0].amount):null,error:e.message});
  }finally{
    setTimeout(()=>liveBusy.delete(id), 2000);
  }
});

app.get("/api/favorites/live",async(req,res)=>{
  const ids=String(req.query.ids||"").split(",").map(x=>decodeURIComponent(x)).filter(Boolean).slice(0,100);
  const rows=[];
  for(const id of ids){
    try{
      const lots=await fetchAllLots(id);
      saveLots(id,lots,new Date().toISOString());
      const item=DB.prepare("SELECT * FROM items WHERE id=?").get(id)||{id,name:id};
      const last=DB.prepare("SELECT price,ts FROM sale_observations WHERE item_id=? ORDER BY datetime(ts) DESC LIMIT 1").get(id);
      rows.push({ok:true,id,name:item.name,lotsCount:lots.length,minPrice:lots[0]?.price??null,minUnitPrice:lots[0]?.price??null,minAmount:lots[0]?.amount??null,minTotalPrice:lots[0]?Math.round(lots[0].price*lots[0].amount):null,lastSale:last?.price??null,ts:new Date().toISOString()});
    }catch(e){
      const item=DB.prepare("SELECT * FROM items WHERE id=?").get(id)||{id,name:id};
      const cached=DB.prepare("SELECT * FROM lots WHERE item_id=? ORDER BY price ASC").all(id);
      const last=DB.prepare("SELECT price,ts FROM sale_observations WHERE item_id=? ORDER BY datetime(ts) DESC LIMIT 1").get(id);
      rows.push({ok:false,id,name:item.name,lotsCount:cached.length,minPrice:cached[0]?.price??null,minUnitPrice:cached[0]?.price??null,minAmount:cached[0]?.amount??null,minTotalPrice:cached[0]?Math.round(cached[0].price*cached[0].amount):null,lastSale:last?.price??null,error:e.message});
    }
  }
  res.json({rows});
});

app.get("/api/icon/:id", async (req, res) => {
  const id = String(req.params.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
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

app.get("/{*splat}",(req,res)=>res.sendFile(path.join(__dirname,"public/index.html")));
app.listen(PORT,()=>console.log(`STALZONE Market Monitor: http://localhost:${PORT}`));

(async()=>{
  try{
    await syncItems();
    scanCycle().catch(e=>lastError=e.message);
  }catch(e){lastError=e.message}
})();

// Adaptive scheduler: uses currentPollMs which grows on API errors
(function scheduleScan(){
  setTimeout(async()=>{
    try{ await scanCycle(); }catch(e){ lastError=e.message; }
    scheduleScan();
  }, Math.max(10000, currentPollMs||POLL_MS));
})();

// Periodic WAL checkpoint
setInterval(()=>{
  try{ DB.pragma("wal_checkpoint(TRUNCATE)"); }catch{}
}, 15*60*1000);
