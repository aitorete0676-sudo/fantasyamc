// Service worker mínimo: permite instalar el fantasy como app. No guarda nada en caché para ver siempre datos al día.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
