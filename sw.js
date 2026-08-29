/* Website Banane Wala — app-style notifications */
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});

self.addEventListener('push', (e) => {
  let data = { title: 'Website Banane Wala', body: 'New update' };
  try {
    if (e.data) data = Object.assign(data, e.data.json());
  } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'Website Banane Wala', {
      body: data.body || '',
      icon: 'https://cdn-icons-png.flaticon.com/192/733/733585.png',
      badge: 'https://cdn-icons-png.flaticon.com/96/733/733585.png',
      renotify: true,
      tag: data.tag || 'wbw-push'
    })
  );
});
