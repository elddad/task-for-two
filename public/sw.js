// Service Worker: מקבל Push ומציג התראה. לחיצה פותחת את האפליקציה.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  // באייפון חובה להציג התראה על כל Push, אחרת ההרשאה נלקחת
  event.waitUntil(
    self.registration.showNotification(data.title || "משימות שלנו", {
      body: data.body || "",
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: "icons/icon-192.png",
      badge: "icons/badge-72.png",
      lang: "he",
      dir: "rtl",
      data: { url: data.url || "./" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if ("focus" in w) {
        await w.focus();
        w.postMessage({ type: "open", url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
