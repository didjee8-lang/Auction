import { IP_WHITELIST } from "./config.js";

export function ipWhitelist(req, res, next) {
  if (!IP_WHITELIST.size) return next();
  const ip = req.ip;
  if (IP_WHITELIST.has(ip)) return next();
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
