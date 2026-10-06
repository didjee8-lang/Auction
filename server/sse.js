/** Server-Sent Events for live market deltas */
const clients = new Set();

export function sseHandler(req, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, t: Date.now() })}\n\n`);

  const client = { res, ip: req.ip };
  clients.add(client);

  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: ${Date.now()}\n\n`); }
    catch { cleanup(); }
  }, 25000);

  function cleanup() {
    clearInterval(ping);
    clients.delete(client);
    try { res.end(); } catch {}
  }
  req.on("close", cleanup);
  req.on("error", cleanup);
}

export function broadcastMarket(payload) {
  if (!clients.size) return;
  const data = `event: market\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of [...clients]) {
    try { c.res.write(data); }
    catch { clients.delete(c); }
  }
}

export function broadcastStatus(payload) {
  if (!clients.size) return;
  const data = `event: status\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of [...clients]) {
    try { c.res.write(data); }
    catch { clients.delete(c); }
  }
}

export function sseClientCount() {
  return clients.size;
}
