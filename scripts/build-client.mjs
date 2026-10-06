import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientSrc = path.join(root, "client", "src");
const assets = path.join(root, "public", "assets");
fs.mkdirSync(assets, { recursive: true });

for (const f of ["app.js", "sse.js", "api.js", "store.js", "styles.css"]) {
  const from = path.join(clientSrc, f);
  if (!fs.existsSync(from)) continue;
  let text = fs.readFileSync(from, "utf8");
  if (f === "app.js") text = text.replace(/import\s+"\.\/styles\.css";\s*/g, "");
  fs.writeFileSync(path.join(assets, f), text);
}

const body = fs.readFileSync(path.join(root, "client", "index.html"), "utf8");
const out = body
  .replace("</head>", '  <link rel="stylesheet" href="/assets/styles.css">\n</head>')
  .replace('src="/src/app.js"', 'src="/assets/app.js"');
fs.writeFileSync(path.join(root, "public", "index.html"), out);
console.log("Client built → public/");
