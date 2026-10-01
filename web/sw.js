// Fortivio — service worker jen pro upozornění (Web Push).
// Nic necachuje: stránka se dál vždy načítá ze serveru (viz .htaccess), takže
// nová verze appky je vidět hned. Notifikace posílá Supabase funkce price-alerts.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Fortivio", {
    body: d.body || "",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: "fortivio-180.png",
    badge: "fortivio-64.png",
    data: { url: d.url || "./" },
  }));
});

// klepnutí: přepnout do otevřené appky a ukázat titul, jinak ji otevřít
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if ("focus" in w) { await w.focus(); w.postMessage({ type: "open", url }); return; }
    }
    await self.clients.openWindow(url);
  })());
});
