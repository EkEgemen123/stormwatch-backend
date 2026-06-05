const webpush = require('web-push');
const keys    = webpush.generateVAPIDKeys();
console.log('\n✅ VAPID Keys üretildi!\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\n👉 Bu değerleri .env dosyasına ve Render Environment Variables\'a yapıştır.\n');
