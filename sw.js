// SOLVATECH BOT - Native Chrome / Web Push Service Worker
const CACHE_NAME = "solvatech-sw-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: "SOLVATECH Payment Alert", body: event.data.text() };
    }
  }

  const title = data.title || "💰 SOLVATECH Payment Alert";
  const body = data.body || "A new payment receipt has been submitted. Tap to review & approve.";
  const icon = data.icon || "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp";
  const badge = data.badge || "https://solvatechofficial.github.io/WHATSAPP-BOT-/solva.webp";
  const targetUrl = (data.data && data.data.url) ? data.data.url : "/?tab=admin&view=payments";

  const options = {
    body,
    icon,
    badge,
    vibrate: [200, 100, 200, 100, 200],
    tag: "solvatech-payment-" + Date.now(),
    renotify: true,
    requireInteraction: true,
    data: {
      url: targetUrl,
      timestamp: Date.now(),
    },
    actions: [
      { action: "open", title: "🔍 Review & Approve" },
      { action: "close", title: "Dismiss" },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "close") return;

  const targetUrl = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : "/?tab=admin&view=payments";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) {
          if (client.url && client.url.includes(self.location.origin)) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
