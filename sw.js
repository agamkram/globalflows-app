/** Drop leftover workers. The book is fetched off the wire every open. */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const windows = await self.clients.matchAll({ type: "window" });
      for (const c of windows) {
        if (c.url) c.navigate(c.url);
      }
    })()
  );
});
