STALZONE Railway fix

What changed:
- package.json now pins Node.js to 22.x via engines.
- package-lock.json root metadata matches Node 22.x.
- server(1).js is supplied as server.js so the existing "npm start" script works.

Deploy:
1. Replace the files in your Railway project with these three files.
2. Commit/push them.
3. Redeploy Railway.
4. In the deploy log, check that Node.js 22.x is used.

Do not delete market.db if you need the existing local database data.
