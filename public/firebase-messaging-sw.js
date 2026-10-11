// Firebase Messaging Service Worker v4
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

// ── Lifecycle ─────────────────────────────────────────────────────────────────
self.addEventListener("install", () => {
  console.log("[FCM SW v4] install");
  self.skipWaiting(); // activate immediately, don't wait for old SW to be released
});

self.addEventListener("activate", evt => {
  console.log("[FCM SW v4] activate");
  evt.waitUntil(self.clients.claim()); // take control of all open pages immediately
});

// Allow the app to force-skip waiting (used during token registration)
self.addEventListener("message", evt => {
  if(evt.data?.type === "SKIP_WAITING"){
    console.log("[FCM SW v4] SKIP_WAITING received");
    self.skipWaiting();
  }
});

// ── Firebase init ─────────────────────────────────────────────────────────────
firebase.initializeApp({
  apiKey:            "AIzaSyD1E8Y3lkwh7utFFXiLbl5S4Z8uPP3CELo",
  authDomain:        "cottagecon-b8d82.firebaseapp.com",
  projectId:         "cottagecon-b8d82",
  storageBucket:     "cottagecon-b8d82.firebasestorage.app",
  messagingSenderId: "920161860391",
  appId:             "1:920161860391:web:332c97ca183ae5411a8702",
});

const messaging = firebase.messaging();

// ── Background messages (app closed or backgrounded) ──────────────────────────
// onBackgroundMessage is a plain callback — NOT an event listener.
// Must RETURN the showNotification Promise (no `event` variable available here).
messaging.onBackgroundMessage(payload => {
  console.log("[FCM SW v4] Background message received:", JSON.stringify(payload));

  // Support both notification payload (Firebase Console) and data-only payload (API)
  const n     = payload.notification || {};
  const d     = payload.data         || {};
  const title = n.title || d.title   || "Cottage Con";
  const body  = n.body  || d.body    || "You have a new update.";
  const icon  = n.icon  || d.icon    || "/icons/icon-192.png";
  const url   = d.url   || "/";

  return self.registration.showNotification(title, {
    body,
    icon,
    badge:              "/icons/icon-72.png",
    vibrate:            [200, 100, 200],
    tag:                "cottage-con",        // replaces previous notification
    renotify:           true,                  // vibrate even if tag matches
    requireInteraction: false,
    data:               { url, ...d },
    actions:            [{ action: "open", title: "Open Cottage Con" }],
  });
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener("notificationclick", evt => {
  console.log("[FCM SW v4] Notification clicked, action:", evt.action);
  evt.notification.close();
  const url = evt.notification.data?.url || "/";
  evt.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      // Focus existing tab if already open
      for(const c of list){
        if(c.url.includes(self.location.origin) && "focus" in c) return c.focus();
      }
      // Otherwise open a new tab
      return clients.openWindow(url);
    })
  );
});
