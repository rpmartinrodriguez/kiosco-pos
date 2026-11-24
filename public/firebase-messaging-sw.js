importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js');
firebase.initializeApp({apiKey:'AIzaSyBONJpNZ51Ie0OVK6NJ8lwmBeNHyEGn7Zc',authDomain:'kiosco-app-15942.firebaseapp.com',projectId:'kiosco-app-15942',storageBucket:'kiosco-app-15942.firebasestorage.app',messagingSenderId:'542035081513',appId:'1:542035081513:web:3a77c345994815563d5f38'});
firebase.messaging();
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(async list=>{for(const c of list){if(new URL(c.url).origin===self.location.origin){await c.focus();return;}}return clients.openWindow('/');}));});
