// Service Worker for Sharify PWA
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// Avoid intercepting WebSockets or dynamic API calls on Safari
self.addEventListener('fetch', (e) => {
  // Let browser handle all requests naturally without breaking WebSockets / Range requests in Safari WebKit
});
