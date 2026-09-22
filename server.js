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
const DB = new Database(process.env.DB_FILE || path.join(__dirname, "market.db"));

DB.pragma("journal_mode = WAL");
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
`);

try { DB.exec("ALTER TABLE lots ADD COLUMN qlt INTEGER"); } catch {}
try { DB.exec("ALTER TABLE lots ADD COLUMN ptn INTEGER"); } catch {}
try { DB.exec("ALTER TABLE sale_observations ADD COLUMN qlt INTEGER"); } catch {}
try { DB.exec("ALTER TABLE sale_observations ADD COLUMN ptn INTEGER"); } catch {}


let token = null, tokenExp = 0, scanning = false, scanCursor = 0, lastScan = null, lastError = null;

async function getToken(){
  if(token && Date.now() < tokenExp - 30000) return token;
  if(!ID || !SECRET) throw new Error("STALZONE_CLIENT_ID / STALZONE_CLIENT_SECRET not configured");
  const body = new URLSearchParams({grant_type:"client_credentials",client_id:ID,client_secret:SECRET});
  const r = await fetch("https://exbo.net/oauth/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const j = await r.json().catch(()=>({}));
  if(!r.ok || !j.access_token) throw new Error(`OAuth ${r.status}: ${JSON.stringify(j)}`);
  token=j.access_token; tokenExp=Date.now()+Number(j.expires_in||3600)*1000; return token;
}

async function api(apiPath){
  const t=await getToken();
  const r=await fetch(`${API}/${REGION}${apiPath}`,{headers:{Authorization:`Bearer ${t}`,Accept:"application/json"}});
  const txt=await r.text();
  let j; try{j=JSON.parse(txt)}catch{j={raw:txt}};
  if(!r.ok) throw new Error(`API ${r.status}: ${txt.slice(0,400)}`);
  return j;
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

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



async function scanOne(item){
  const j=await api(`/auction/${encodeURIComponent(item.id)}/lots?limit=200&sort=buyout_price&order=asc&additional=true`);
  const lots=parseLots(j);
  const now=new Date().toISOString();
  // clear old lots for item then insert fresh
  DB.prepare("DELETE FROM lots WHERE item_id=?").run(item.id);
  const ins=DB.prepare(`INSERT OR REPLACE INTO lots(item_id,lot_id,price,amount,created_at,raw,seen_at,qlt,ptn) VALUES(?,?,?,?,?,?,?,?,?)`);
  const tx=DB.transaction(a=>{for(const x of a)ins.run(item.id,x.id,x.price,x.amount,x.created,x.raw,now,x.qlt,x.ptn)});
  tx(lots);
  const prices=lots.map(x=>x.price).sort((a,b)=>a-b);
  const min=prices[0]||null,max=prices.length?prices[prices.length-1]:null;
  const avg=prices.length?prices.reduce((a,b)=>a+b,0)/prices.length:null;
  DB.prepare(`INSERT OR REPLACE INTO price_observations(item_id,ts,min_price,avg_price,max_price,lots,sales) VALUES(?,?,?,?,?,?,0)`)
    .run(item.id,now,min,avg,max,lots.length);

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
  scanning=true; lastError=null;
  try{
    let all=DB.prepare("SELECT * FROM items").all();
    if(!all.length){ await syncItems(); all=DB.prepare("SELECT * FROM items").all(); }

    // Priority: items that already have lots or recent sales first
    const hotIds=new Set(
      DB.prepare("SELECT DISTINCT item_id FROM lots").all().map(x=>x.item_id)
        .concat(DB.prepare("SELECT DISTINCT item_id FROM sale_observations").all().map(x=>x.item_id))
    );
    all.sort((a,b)=>{
      const ah=hotIds.has(a.id)?0:1;
      const bh=hotIds.has(b.id)?0:1;
      if(ah!==bh) return ah-bh;
      return (a.id||"").localeCompare(b.id||"");
    });

    // rotate through list
    const selected=[];
    for(let k=0;k<Math.min(MAX_ITEMS_PER_CYCLE,all.length);k++){
      selected.push(all[(scanCursor+k)%all.length]);
    }
    scanCursor=(scanCursor+selected.length)%Math.max(all.length,1);

    // process in parallel batches
    for(let i=0;i<selected.length;i+=CONCURRENCY){
      const batch=selected.slice(i,i+CONCURRENCY);
      await mapPool(batch, CONCURRENCY, scanOne);
      if(i+CONCURRENCY<selected.length) await sleep(BATCH_DELAY_MS);
    }
    lastScan=new Date().toISOString();
    console.log(`Scan done: ${selected.length} items, cursor=${scanCursor}`);
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
  concurrency:CONCURRENCY
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

app.get("/api/market",(_,res)=>{
  const q=String(_.query.q||"").toLowerCase();
  let items=DB.prepare("SELECT * FROM items ORDER BY name").all();
  if(q)items=items.filter(x=>(x.name||"").toLowerCase().includes(q)||(x.id||"").toLowerCase().includes(q));

  const getLast=DB.prepare(`SELECT * FROM price_observations WHERE item_id=? ORDER BY ts DESC LIMIT 1`);
  const getLots=DB.prepare(`SELECT price, amount, qlt, ptn FROM lots WHERE item_id=? ORDER BY price ASC`);
  const getSalesGroup=DB.prepare(`SELECT price, amount FROM sale_observations WHERE item_id=? AND (qlt IS ? OR (qlt IS NULL AND ? IS NULL)) AND (ptn IS ? OR (ptn IS NULL AND ? IS NULL))`);

  const rows=items.map(x=>{
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

    // Same qlt+ptn group for fair comparison
    const sameLots=lotRows.filter(l=>l.qlt===minQlt && l.ptn===minPtn).map(l=>l.price).filter(p=>p>0);

    // IMPORTANT: the market/profit reference must follow the recent sales shown
    // to the user, not the entire historical database. Old high prices can otherwise
    // produce a fake profit even when current lots and recent sales are ~900k.
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
      // C: only current lots of same rarity+enhancement
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
      lastSale,
      changeVsLast,
      status,statusLabel,
      profit,profitPct,
      ts:o?.ts||null
    };
  });
  res.json({updated:lastScan,rows});
});

app.get("/api/item/:id",async(req,res)=>{
  const item=DB.prepare("SELECT * FROM items WHERE id=?").get(req.params.id);
  if(!item)return res.status(404).json({error:"item not found"});
  // Opening an item performs a live refresh of active lots, so a purchased
  // lot disappears immediately instead of waiting for the background scanner.
  let lots=[];
  try{
    const lj=await api(`/auction/${encodeURIComponent(item.id)}/lots?limit=200&sort=buyout_price&order=asc&additional=true`);
    lots=parseLots(lj);
    const now=new Date().toISOString();
    DB.prepare("DELETE FROM lots WHERE item_id=?").run(item.id);
    const lins=DB.prepare(`INSERT OR REPLACE INTO lots(item_id,lot_id,price,amount,created_at,raw,seen_at,qlt,ptn) VALUES(?,?,?,?,?,?,?,?,?)`);
    const ltx=DB.transaction(a=>{for(const l of a)lins.run(item.id,l.id,l.price,l.amount,l.created,l.raw||JSON.stringify(l),now,l.qlt,l.ptn)});
    ltx(lots);
    const prices=lots.map(l=>l.price).filter(p=>p>0).sort((a,b)=>a-b);
    DB.prepare(`INSERT OR REPLACE INTO price_observations(item_id,ts,min_price,avg_price,max_price,lots,sales) VALUES(?,?,?,?,?,?,0)`)
      .run(item.id,now,prices[0]||null,prices.length?prices.reduce((a,b)=>a+b,0)/prices.length:null,prices.length?prices[prices.length-1]:null,lots.length);
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
setInterval(()=>scanCycle().catch(e=>lastError=e.message),POLL_MS);
