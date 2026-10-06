import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");

export const PORT = Number(process.env.PORT || 4173);
export const REGION = (process.env.STALZONE_REGION || "RU").toUpperCase();
export const API = process.env.STALZONE_API_BASE || "https://eapi.stalzone.com";
export const ID = process.env.STALZONE_CLIENT_ID;
export const SECRET = process.env.STALZONE_CLIENT_SECRET;
export const POLL_MS = Number(process.env.POLL_INTERVAL_MS || 45000);
export const CONCURRENCY = Number(process.env.SCAN_CONCURRENCY || 5);
export const BATCH_DELAY_MS = Number(process.env.BATCH_DELAY_MS || 200);
export const MAX_ITEMS_PER_CYCLE = Number(process.env.MAX_ITEMS_PER_CYCLE || 400);
export const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || (fs.existsSync("/app/data") ? "/app/data" : path.join(rootDir, "data"));
fs.mkdirSync(DATA_DIR, { recursive: true });
export const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, "market.db");
export const PUBLIC_DIR = path.join(rootDir, "public");
export const ICONS_DIR = path.join(PUBLIC_DIR, "icons");
fs.mkdirSync(ICONS_DIR, { recursive: true });

export const IP_WHITELIST = new Set(
  (process.env.IP_WHITELIST || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean)
);

export const ALWAYS_PRIORITY = [
  "rdt1m5ve",
  "55VrA59M", "WdVYNOia", "nb0OaSNs", "rA8fsgH1", "skuTyVhI", "vKJbSN93", "vpxznHgV",
  "8AjTFOVB", "cpe1d8xz", "kJD59qaP",
];

export const FALLBACK_ITEMS = {
  rdt1m5ve: { name: "Протоартефакт", category: "other/useful" },
  "8AjTFOVB": { name: "Сезонный Пропуск", category: "other/useful" },
  cpe1d8xz: { name: "Сезонный Пропуск + 50 уровней", category: "other/useful" },
  kJD59qaP: { name: "Сезонный Пропуск + 20 уровней", category: "other/useful" },
  "55VrA59M": { name: "Протоартефакт «Омута»", category: "other/trash" },
  WdVYNOia: { name: "Протоартефакт «Батута»", category: "other/trash" },
  nb0OaSNs: { name: "Протоартефакт «Застоя»", category: "other/trash" },
  rA8fsgH1: { name: "Протоартефакт «Холодца»/«Пуха»", category: "other/trash" },
  skuTyVhI: { name: "Протоартефакт «Разряда»/«Застоя»", category: "other/trash" },
  vKJbSN93: { name: "Протоартефакт «Зажигалки»/Мороза", category: "other/trash" },
  vpxznHgV: { name: "Протоартефакт «Волчка»", category: "other/trash" },
  "2opw0": { name: "Премиум на 30 дней", category: "other/useful" },
  "3gv2z": { name: "Премиум на 90 дней", category: "other/useful" },
  "7l9d3": { name: "Премиум на 180 дней", category: "other/useful" },
  m0jyj: { name: "Премиум на 1 день", category: "other/useful" },
  n4lo6: { name: "Премиум на 3 дня", category: "other/useful" },
  vjd5n: { name: "Премиум на 7 дней", category: "other/useful" },
  dm195: { name: "Премиум на 14 дней", category: "other/useful" },
  w3zn3: { name: "Боевой жетон", category: "other/useful" },
};

export const QLT_LABELS = { 0: "Обычное", 1: "Необычное", 2: "Особое", 3: "Редкое", 4: "Исключительное", 5: "Легендарное", 6: "Уникальное" };
export const QLT_SHORT = { 0: "серый", 1: "зелён", 2: "синий", 3: "фиол", 4: "красн", 5: "желт", 6: "уникал" };
export const QLT_COLOR = { 0: "#9ca3af", 1: "#4ade80", 2: "#60a5fa", 3: "#c084fc", 4: "#f87171", 5: "#fbbf24", 6: "#ff2a2a" };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
