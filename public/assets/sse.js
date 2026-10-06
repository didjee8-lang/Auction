/** Server-Sent Events — live market push */
let es = null;
let onMarket = null;
let onStatus = null;
let backoff = 1000;

export function connectSSE(handlers = {}) {
  onMarket = handlers.onMarket || null;
  onStatus = handlers.onStatus || null;
  open();
}

function open() {
  if (es) {
    try { es.close(); } catch {}
    es = null;
  }
  try {
    es = new EventSource("/api/stream");
  } catch (e) {
    scheduleReconnect();
    return;
  }
  es.addEventListener("hello", () => {
    backoff = 1000;
  });
  es.addEventListener("market", (ev) => {
    backoff = 1000;
    try {
      const data = JSON.parse(ev.data);
      if (onMarket) onMarket(data);
    } catch {}
  });
  es.addEventListener("status", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (onStatus) onStatus(data);
    } catch {}
  });
  es.onerror = () => {
    try { es.close(); } catch {}
    es = null;
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  const wait = Math.min(backoff, 15000);
  backoff = Math.min(backoff * 1.5, 15000);
  setTimeout(open, wait);
}

export function disconnectSSE() {
  if (es) {
    try { es.close(); } catch {}
    es = null;
  }
}
