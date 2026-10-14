/** Standalone Перекуп — same look & localStorage (sz_pod_rows / sz_pod_hist) as main site */
const $=id=>document.getElementById(id);
function fmt(n){if(n==null||!isFinite(n))return"—";const x=Number(n);if(Number.isInteger(x))return x.toLocaleString("ru-RU")+" ₽";return x.toLocaleString("ru-RU",{maximumFractionDigits:2})+" ₽"}
function fmtN(n){return(n==null||!isFinite(n))?"—":Number(n).toLocaleString("ru-RU")}
function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}

let podRows=(()=>{ try{ return JSON.parse(localStorage.getItem("sz_pod_rows")||"[]"); }catch{ return []; } })();
if(!Array.isArray(podRows)) podRows=[];
const POD_COLORS=[
  "#f2f2f2","#d1d5db","#9ca3af","#6b7280","#374151",
  "#fef08a","#fbbf24","#f59e0b","#ea580c","#c2410c",
  "#86efac","#4ade80","#22c55e","#16a34a","#166534",
  "#7dd3fc","#60a5fa","#3b82f6","#2563eb","#1d4ed8",
  "#c4b5fd","#a78bfa","#c084fc","#a855f7","#7c3aed",
  "#f9a8d4","#f472b6","#ec4899","#db2777","#9d174d",
  "#fca5a5","#f87171","#ef4444","#ff2a2a","#b91c1c",
  "#5eead4","#2dd4bf","#14b8a6","#0d9488","#0f766e",
];
const POD_COLOR_LEGACY={
  white:"#f2f2f2",grey:"#9ca3af",green:"#4ade80",blue:"#60a5fa",
  purple:"#c084fc",red:"#f87171",yellow:"#fbbf24",unique:"#ff2a2a"
};
function podColorHex(c){
  if(!c) return POD_COLORS[0];
  if(String(c).startsWith("#")) return c;
  return POD_COLOR_LEGACY[c]||POD_COLORS[0];
}
function savePod(){ try{ localStorage.setItem("sz_pod_rows", JSON.stringify(podRows)); }catch{} }
function podNewId(){ return "p"+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }
let podHist=(()=>{ try{ return JSON.parse(localStorage.getItem("sz_pod_hist")||"[]"); }catch{ return []; } })();
if(!Array.isArray(podHist)) podHist=[];
function savePodHist(){ try{ localStorage.setItem("sz_pod_hist", JSON.stringify(podHist)); }catch{} }
function calcNum(v){
  if(v==null) return NaN;
  const s=String(v).replace(/\s+/g,"").replace(/,/g,".");
  return s===""?NaN:Number(s);
}

function copyPlainNumber(n, el){
  if(n==null || !Number.isFinite(Number(n))) return;
  const text=String(Math.round(Number(n)));
  const flash=()=>{
    if(!el) return;
    const prev=el.style.borderColor;
    el.style.borderColor="var(--neon)";
    el.style.background="var(--glow)";
    setTimeout(()=>{ el.style.borderColor=prev||"transparent"; el.style.background=""; },450);
  };
  const done=()=>{ flash(); try{ if(navigator.vibrate) navigator.vibrate(12); }catch{} };
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(()=>{
      const ta=document.createElement("textarea");
      ta.value=text; document.body.appendChild(ta); ta.select();
      try{ document.execCommand("copy"); }catch{}
      ta.remove(); done();
    });
  }else{
    const ta=document.createElement("textarea");
    ta.value=text; document.body.appendChild(ta); ta.select();
    try{ document.execCommand("copy"); }catch{}
    ta.remove(); done();
  }
}

function snapshotPodForHistory(){
  const lines=[];
  let total=0;
  for(const r of podRows){
    const p=calcNum(r.price), q=calcNum(r.qty);
    if(!Number.isFinite(p)||p<0||!Number.isFinite(q)||q<=0) continue;
    const sum=Math.round(p*q);
    total+=sum;
    lines.push({
      name: String(r.name||"Без названия"),
      color: podColorHex(r.color),
      price: String(Math.round(p)),
      qty: String(Math.round(q)),
      sum: String(sum)
    });
  }
  if(!lines.length) return null;
  return {
    id: "h"+Date.now().toString(36)+Math.random().toString(36).slice(2,5),
    ts: new Date().toISOString(),
    total: String(Math.round(total)),
    lines
  };
}

function savePodHistoryFromSum(){
  const snap=snapshotPodForHistory();
  if(!snap) return false;
  // не дублировать подряд одинаковый снимок (тот же total + те же строки)
  const prev=podHist[0];
  if(prev && prev.total===snap.total && JSON.stringify(prev.lines)===JSON.stringify(snap.lines)){
    return true; // уже есть
  }
  podHist.unshift(snap);
  if(podHist.length>100) podHist=podHist.slice(0,100);
  savePodHist();
  if($("podHistPanel")?.style.display!=="none") renderPodHist();
  return true;
}

function renderPodHist(){
  const box=$("podHistList"); if(!box) return;
  if(!podHist.length){
    box.innerHTML=`<div class="empty">Пока пусто — кликни по общей сумме</div>`;
    return;
  }
  box.innerHTML=podHist.map(h=>{
    const when=h.ts?new Date(h.ts).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"}):"—";
    const rows=(h.lines||[]).map(l=>`
      <div class="info-row">
        <span style="color:${esc(l.color||"#f2f2f2")};font-weight:600">${esc(l.name)}</span>
        <b>${esc(l.qty)} × ${fmt(l.price)} = <span style="color:var(--neon2)">${fmt(l.sum)}</span></b>
      </div>`).join("");
    return `<div class="calc-item-info" style="margin-bottom:8px">
      <div class="title" style="display:flex;justify-content:space-between;gap:8px;align-items:center">
        <span>${when}</span>
        <span style="display:flex;gap:8px;align-items:center">
          <b class="pod-copy pod-hist-total" data-raw="${esc(h.total)}" title="Копировать сумму" style="color:var(--neon2);cursor:pointer">${fmt(h.total)}</b>
          <button type="button" class="rm pod-hist-rm" data-id="${esc(h.id)}">×</button>
        </span>
      </div>
      ${rows}
    </div>`;
  }).join("");
  box.querySelectorAll(".pod-hist-rm").forEach(btn=>{
    btn.onclick=()=>{
      podHist=podHist.filter(x=>x.id!==btn.dataset.id);
      savePodHist(); renderPodHist();
    };
  });
  box.querySelectorAll(".pod-hist-total").forEach(el=>{
    el.onclick=()=>{
      const n=Number(el.dataset.raw);
      if(Number.isFinite(n)) copyPlainNumber(n, el);
    };
  });
}

function recalcPod(){
  let total=0, lines=0;
  for(const r of podRows){
    const p=calcNum(r.price), q=calcNum(r.qty);
    const sum=(Number.isFinite(p)&&p>=0&&Number.isFinite(q)&&q>0)?p*q:NaN;
    const cell=document.querySelector(`#podBody tr[data-pod-id="${CSS.escape(r.id)}"] .pod-line-sum`);
    if(cell){
      cell.textContent=Number.isFinite(sum)?fmt(sum):"—";
      cell.dataset.raw=Number.isFinite(sum)?String(Math.round(sum)):"";
      cell.classList.add("pod-copy");
      cell.title=Number.isFinite(sum)?"Нажми, чтобы скопировать":"";
      cell.style.cursor=Number.isFinite(sum)?"pointer":"default";
    }
    if(Number.isFinite(sum)){ total+=sum; lines++; }
  }
  const el=$("podSum");
  if(el){
    el.textContent=lines?fmt(total):"—";
    el.dataset.raw=lines?String(Math.round(total)):"";
  }
  if($("podLines")) $("podLines").textContent=String(lines);
}

function bindPodInputs(){
  const body=$("podBody"); if(!body) return;
  body.querySelectorAll("input[data-pod-name]").forEach(inp=>{
    inp.oninput=()=>{
      const id=inp.dataset.podName;
      const row=podRows.find(x=>x.id===id); if(!row) return;
      row.name=inp.value;
      inp.style.color=podColorHex(row.color);
      savePod();
    };
  });
  body.querySelectorAll(".pod-color-btn").forEach(btn=>{
    btn.onclick=e=>{
      e.stopPropagation();
      const id=btn.dataset.podId;
      body.querySelectorAll(".pod-color-pop").forEach(p=>{
        if(p.dataset.podId!==id) p.style.display="none";
      });
      const pop=body.querySelector(`.pod-color-pop[data-pod-id="${CSS.escape(id)}"]`);
      if(!pop) return;
      const open=pop.style.display==="none"||!pop.style.display;
      pop.style.display=open?"grid":"none";
    };
  });
  body.querySelectorAll(".pod-swatch").forEach(btn=>{
    btn.onclick=e=>{
      e.stopPropagation();
      const id=btn.dataset.podId;
      const hex=btn.dataset.hex;
      const row=podRows.find(x=>x.id===id); if(!row) return;
      row.color=hex;
      const nameInp=body.querySelector(`input[data-pod-name="${CSS.escape(id)}"]`);
      if(nameInp) nameInp.style.color=hex;
      const main=body.querySelector(`.pod-color-btn[data-pod-id="${CSS.escape(id)}"]`);
      if(main){ main.style.background=hex; main.style.boxShadow=`0 0 0 2px ${hex}55`; }
      const pop=body.querySelector(`.pod-color-pop[data-pod-id="${CSS.escape(id)}"]`);
      if(pop){
        pop.style.display="none";
        pop.querySelectorAll(".pod-swatch").forEach(s=>{
          s.style.outline=s.dataset.hex===hex?"2px solid #fff":"1px solid rgba(255,255,255,.2)";
        });
      }
      savePod();
    };
  });
  body.querySelectorAll("input[data-pod-price]").forEach(inp=>{
    inp.oninput=()=>{
      const id=inp.dataset.podPrice;
      const row=podRows.find(x=>x.id===id); if(!row) return;
      let raw=inp.value.replace(/[^0-9.,]/g,"");
      if(raw!==inp.value) inp.value=raw;
      row.price=raw.trim();
      savePod(); recalcPod();
    };
  });
  body.querySelectorAll("input[data-pod-qty]").forEach(inp=>{
    inp.oninput=()=>{
      const id=inp.dataset.podQty;
      const row=podRows.find(x=>x.id===id); if(!row) return;
      let raw=inp.value.replace(/[^0-9]/g,"");
      if(raw!==inp.value) inp.value=raw;
      row.qty=raw.trim();
      savePod(); recalcPod();
    };
    inp.onkeydown=e=>{
      if(e.key==="Enter"){
        e.preventDefault();
        const next=inp.closest("tr")?.nextElementSibling?.querySelector("input[data-pod-qty]");
        if(next){ next.focus(); next.select(); }
      }
    };
  });
  body.querySelectorAll(".pod-rm").forEach(btn=>{
    btn.onclick=()=>{
      podRows=podRows.filter(x=>x.id!==btn.dataset.id);
      savePod(); renderPod({skipFocus:true});
    };
  });
}

function reorderPodRows(fromId, toId, placeAfter){
  const from=podRows.findIndex(r=>r.id===fromId);
  const to=podRows.findIndex(r=>r.id===toId);
  if(from<0||to<0||from===to) return false;
  const [item]=podRows.splice(from,1);
  let insertAt=podRows.findIndex(r=>r.id===toId);
  if(insertAt<0) return false;
  if(placeAfter) insertAt+=1;
  podRows.splice(insertAt,0,item);
  savePod();
  return true;
}

function bindPodDrag(body){
  if(!body) return;
  let dragId=null, activeTr=null, lastTarget=null, lastPlace=null;
  const clearMarks=()=>{
    body.querySelectorAll("tr.pod-drop-before,tr.pod-drop-after,tr.pod-dragging").forEach(tr=>{
      tr.classList.remove("pod-drop-before","pod-drop-after","pod-dragging");
    });
  };
  const onMove=(e)=>{
    if(!dragId) return;
    e.preventDefault();
    const y=e.touches?e.touches[0].clientY:e.clientY;
    const x=e.touches?e.touches[0].clientX:e.clientX;
    const el=document.elementFromPoint(x,y);
    const tr=el&&el.closest?el.closest("#podBody tr[data-pod-id]"):null;
    clearMarks();
    if(activeTr) activeTr.classList.add("pod-dragging");
    if(!tr || tr.dataset.podId===dragId){ lastTarget=null; return; }
    const rect=tr.getBoundingClientRect();
    const after=(y-rect.top)>rect.height/2;
    tr.classList.add(after?"pod-drop-after":"pod-drop-before");
    lastTarget=tr.dataset.podId;
    lastPlace=after?"after":"before";
  };
  const onEnd=(e)=>{
    if(!dragId) return;
    e.preventDefault();
    const from=dragId, to=lastTarget, place=lastPlace;
    dragId=null; activeTr=null; lastTarget=null; lastPlace=null;
    clearMarks();
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onEnd);
    document.removeEventListener("pointercancel", onEnd);
    document.removeEventListener("touchmove", onMove, {passive:false});
    document.removeEventListener("touchend", onEnd);
    if(to && from!==to){
      if(reorderPodRows(from, to, place==="after")) renderPod({skipFocus:true});
    }
  };
  body.querySelectorAll(".pod-drag").forEach(handle=>{
    handle.addEventListener("pointerdown", e=>{
      if(e.button!=null && e.button!==0) return;
      e.preventDefault();
      e.stopPropagation();
      dragId=handle.dataset.podDrag;
      activeTr=handle.closest("tr");
      clearMarks();
      if(activeTr) activeTr.classList.add("pod-dragging");
      try{ handle.setPointerCapture(e.pointerId); }catch{}
      document.addEventListener("pointermove", onMove, {passive:false});
      document.addEventListener("pointerup", onEnd);
      document.addEventListener("pointercancel", onEnd);
    });
    // touch fallback
    handle.addEventListener("touchstart", e=>{
      if(dragId) return;
      e.preventDefault();
      dragId=handle.dataset.podDrag;
      activeTr=handle.closest("tr");
      clearMarks();
      if(activeTr) activeTr.classList.add("pod-dragging");
      document.addEventListener("touchmove", onMove, {passive:false});
      document.addEventListener("touchend", onEnd);
    }, {passive:false});
  });
}

function renderPod(opts){
  const body=$("podBody"); if(!body) return;
  if(!podRows.length){
    body.innerHTML=`<tr><td colspan="6" class="empty" style="padding:20px">Нажми «+ Строка» — добавь товар и цену / шт.</td></tr>`;
    recalcPod();
    return;
  }
  const focused=document.activeElement;
  const keep=focused&&focused.closest&&focused.closest("#podBody")?{
    field: focused.dataset.podName?"name":focused.dataset.podPrice?"price":focused.dataset.podQty?"qty":focused.dataset.podColor?"color":null,
    id: focused.dataset.podName||focused.dataset.podPrice||focused.dataset.podQty||focused.dataset.podColor,
    start: focused.selectionStart, end: focused.selectionEnd
  }:null;

  body.innerHTML=podRows.map(r=>{
    const hex=podColorHex(r.color);
    const swatches=POD_COLORS.map(h=>{
      const on=h.toLowerCase()===hex.toLowerCase();
      return `<button type="button" class="pod-swatch" data-pod-id="${esc(r.id)}" data-hex="${h}"
        style="width:22px;height:22px;border-radius:5px;background:${h};border:none;padding:0;cursor:pointer;
        outline:${on?"2px solid #fff":"1px solid rgba(255,255,255,.2)"};box-shadow:${on?"0 0 6px rgba(255,255,255,.35)":"none"}"></button>`;
    }).join("");
    return `<tr data-pod-id="${esc(r.id)}">
      <td class="pod-drag-td" style="vertical-align:middle">
        <button type="button" class="pod-drag" data-pod-drag="${esc(r.id)}" title="Перетащить" aria-label="Перетащить">☰</button>
      </td>
      <td style="vertical-align:middle;width:48px">
        <div class="pod-color-wrap" style="position:relative;display:inline-block">
          <button type="button" class="pod-color-btn" data-pod-id="${esc(r.id)}" title="Цвет"
            style="width:28px;height:28px;border-radius:7px;background:${hex};border:1px solid var(--border);
            cursor:pointer;box-shadow:0 0 0 2px ${hex}55;padding:0"></button>
          <div class="pod-color-pop" data-pod-id="${esc(r.id)}"
            style="display:none;position:absolute;left:0;top:34px;z-index:50;grid-template-columns:repeat(5,22px);gap:5px;
            padding:8px;background:#0a0a0a;border:1px solid var(--border);border-radius:10px;
            box-shadow:0 12px 28px rgba(0,0,0,.75),0 0 12px var(--glow)">${swatches}</div>
        </div>
      </td>
      <td><input type="text" data-pod-name="${esc(r.id)}" value="${esc(r.name||"")}" placeholder="Название" autocomplete="off" class="pod-name-inp" style="color:${hex};font-weight:600;width:100%;min-width:0;background:var(--bg);border:1px solid var(--border);padding:7px 8px;border-radius:6px;box-sizing:border-box"></td>
      <td><input type="text" inputmode="decimal" data-pod-price="${esc(r.id)}" value="${esc(String(r.price??""))}" placeholder="Цена / шт." autocomplete="off"></td>
      <td><input type="text" inputmode="numeric" data-pod-qty="${esc(r.id)}" value="${esc(String(r.qty??""))}" placeholder="Кол-во" autocomplete="off"></td>
      <td class="pod-line-sum pod-copy" style="font-weight:700;color:var(--neon2);user-select:none;padding:2px 6px;border-radius:6px;border:1px dashed transparent">—</td>
      <td><button type="button" class="rm pod-rm" data-id="${esc(r.id)}">×</button></td>
    </tr>`;
  }).join("");
  bindPodInputs();
  bindPodDrag(body);
  body.querySelectorAll(".pod-line-sum").forEach(cell=>{
    cell.onclick=()=>{ const n=Number(cell.dataset.raw); if(Number.isFinite(n)) copyPlainNumber(n, cell); };
  });
  recalcPod();
  if(keep&&keep.field&&!opts?.skipFocus){
    requestAnimationFrame(()=>{
      const attr=keep.field==="name"?"data-pod-name":keep.field==="price"?"data-pod-price":keep.field==="qty"?"data-pod-qty":null;
      if(!attr) return;
      const el=document.querySelector(`#podBody [${attr}="${CSS.escape(keep.id)}"]`);
      if(el){
        el.focus({preventScroll:true});
        try{ if(el.setSelectionRange) el.setSelectionRange(keep.start, keep.end); }catch{}
      }
    });
  }
}

function podAddRow(){
  podRows.push({id:podNewId(), name:"", color:"#f2f2f2", price:"", qty:""});
  savePod();
  renderPod({skipFocus:true});
  requestAnimationFrame(()=>{
    const last=document.querySelector("#podBody tr:last-child input[data-pod-name]");
    if(last) last.focus();
  });
}

function wirePodApp(){
  $("podAddRow")?.addEventListener("click",()=>podAddRow());
  $("podClearQty")?.addEventListener("click",()=>{
    for(const r of podRows) r.qty="";
    savePod(); renderPod({skipFocus:true});
  });
  $("podClearAll")?.addEventListener("click",()=>{
    if(!podRows.length) return;
    if(!confirm("Удалить все строки подсчёта?")) return;
    podRows=[]; savePod(); renderPod({skipFocus:true});
  });
  $("podSum")?.addEventListener("click",()=>{
    const n=Number($("podSum").dataset.raw);
    if(!Number.isFinite(n)) return;
    copyPlainNumber(n, $("podSum"));
    savePodHistoryFromSum();
  });
  $("podHistBtn")?.addEventListener("click",()=>{
    const panel=$("podHistPanel");
    if(!panel) return;
    const open=panel.style.display==="none"||!panel.style.display;
    panel.style.display=open?"block":"none";
    if(open) renderPodHist();
  });
  $("podHistClear")?.addEventListener("click",()=>{
    if(!podHist.length) return;
    if(!confirm("Очистить историю подсчётов?")) return;
    podHist=[]; savePodHist(); renderPodHist();
  });
  document.addEventListener("click",e=>{
    if(e.target.closest(".pod-color-btn")||e.target.closest(".pod-color-pop")) return;
    document.querySelectorAll(".pod-color-pop").forEach(p=>p.style.display="none");
  });
  window.addEventListener("storage",e=>{
    if(e.key==="sz_pod_rows"||e.key==="sz_pod_hist"){
      try{ podRows=JSON.parse(localStorage.getItem("sz_pod_rows")||"[]"); }catch{ podRows=[]; }
      if(!Array.isArray(podRows)) podRows=[];
      try{ podHist=JSON.parse(localStorage.getItem("sz_pod_hist")||"[]"); }catch{ podHist=[]; }
      if(!Array.isArray(podHist)) podHist=[];
      renderPod({skipFocus:true});
      if($("podHistPanel")?.style.display!=="none") renderPodHist();
    }
  });
  if(!podRows.length) podAddRow();
  else renderPod({skipFocus:true});
  applyCompactLayout();
}
function applyCompactLayout(){
  const w=window.innerWidth, h=window.innerHeight;
  document.body.classList.toggle("compact-ui", w<=700 || h<=640);
  document.body.classList.toggle("tiny-ui", w<=520 || h<=520);
}
window.addEventListener("resize",()=>{ clearTimeout(window._compactT); window._compactT=setTimeout(applyCompactLayout,80); });
document.addEventListener("DOMContentLoaded", wirePodApp);
