# STALZONE Auction Monitor

Node.js + Express + SQLite, modular server, SSE live updates, ES-module client.

## Layout

```
server.js                 # entry → startServer()
server/
  config.js               # env, paths, constants
  db.js                   # SQLite + schema
  middleware.js           # IP whitelist
  sse.js                  # Server-Sent Events hub
  state.js                # shared runtime state helpers
  engine.js               # API routes, scan cycle, market rows
client/
  index.html              # markup source
  src/
    app.js                # UI (auction / favs / calc / deals / catalog)
    styles.css
    sse.js                # EventSource client
    api.js
    store.js
scripts/build-client.mjs  # copies client → public/
public/                   # served by Express (index + assets + icons)
```

## Commands

```bash
npm install
npm run build    # client → public/
npm start        # http://localhost:4173
```

Copy icons into `public/icons/` if needed (from your previous deploy).

## Env

See `.env.example`. Required: `STALZONE_CLIENT_ID`, `STALZONE_CLIENT_SECRET`.

## SSE

- `GET /api/stream` — `event: market` after each scan, `event: status` for scanner
- Client listens and calls a light `/api/market` refresh
- Fallback HTTP poll every 15s if the stream drops

## Notes

- Still Node 22 + Express + better-sqlite3 (no language change)
- Logic of market/scan preserved; code is split for maintainability
- Frontend `app.js` can be split further into `modules/auction.js` etc. incrementally
