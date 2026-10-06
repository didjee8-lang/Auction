/** HTTP helpers */
export async function getJSON(url, opts) {
  const r = await fetch(url, { cache: "no-store", ...opts });
  return r.json();
}

export async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
