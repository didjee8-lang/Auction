/** Shared client state */
export let rows = [];
export function setRows(v) { rows = v; }

export let filter = "all";
export let sortBy = "new";
export let activeId = null;
export let catFilter = "";
export let rightTab = "catalog";
export let activeCategory = null;
export let marketUpdatedAt = null;

export function setFilter(v) { filter = v; }
export function setSortBy(v) { sortBy = v; }
export function setActiveId(v) { activeId = v; }
export function setRightTab(v) { rightTab = v; }
export function setActiveCategory(v) { activeCategory = v; }
export function setMarketUpdatedAt(v) { marketUpdatedAt = v; }
