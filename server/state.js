/** Shared runtime state for scanner + HTTP + SSE */
export let token = null;
export let tokenExp = 0;
export let scanning = false;
export let scanCursor = 0;
export let lastScan = null;
export let lastError = null;
export let apiBackoffUntil = 0;
export let apiFailStreak = 0;
export let currentPollMs = null; // set from config on boot
export const liveBusy = new Set();
export let marketCache = { at: 0, rows: null, updated: null };
export const MARKET_CACHE_MS = 2500;

export function setToken(t, exp) { token = t; tokenExp = exp; }
export function setScanning(v) { scanning = v; }
export function setScanCursor(v) { scanCursor = v; }
export function setLastScan(v) { lastScan = v; }
export function setLastError(v) { lastError = v; }
export function setApiBackoffUntil(v) { apiBackoffUntil = v; }
export function setApiFailStreak(v) { apiFailStreak = v; }
export function setCurrentPollMs(v) { currentPollMs = v; }
export function invalidateMarketCache() { marketCache = { at: 0, rows: null, updated: lastScan }; }
export function setMarketCache(v) { marketCache = v; }
