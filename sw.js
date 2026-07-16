const CACHE="nvdv-crm-v1.1.0-estable-e1";
const ASSETS=["./","./index.html","./styles.css","./app.js","./config.js","./manifest.webmanifest","./icons/icon-192.png","./icons/icon-512.png","./assets/logo_nvdv_pharma.png","./assets/icons/home.png","./assets/icons/event.png","./assets/icons/local_pharmacy.png","./assets/icons/deployed_code.png","./assets/icons/settings.png"];
self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));
});
self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
  );
  self.clients.claim();
});
self.addEventListener("message",event=>{
  if(event.data?.type==="SKIP_WAITING") self.skipWaiting();
});
self.addEventListener("fetch",event=>{
  if(event.request.method!=="GET") return;
  event.respondWith(
    fetch(event.request).then(response=>{
      const copy=response.clone();
      caches.open(CACHE).then(cache=>cache.put(event.request,copy));
      return response;
    }).catch(()=>caches.match(event.request).then(response=>response||caches.match("./index.html")))
  );
});
