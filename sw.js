/* おもいで付箋ボード — sw.js
 * ホーム画面への追加（インストール）と、Googleマップなどからの「共有」を受け取るためのサービスワーカー。
 * 古い画面が残らないよう、キャッシュは使わず常にネットワークから読み込みます。 */
const SW_VERSION = '1.6.0';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request));
});
