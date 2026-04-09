require('dotenv').config();
const admin = require('firebase-admin');

// Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const token = 'fxvw9agYSwGFC9nHCb_8uy:APA91bEkCDljZj81fFjQL4cQYqcQMm2gQ7D-SjdXammJlXICj31R2VXdthB8RKb0UlSVXYoFEOFWDo23GSG5icwKdPRnQjOSPJJZyT88mnyx7LzP5Y9w09w';

const message = {
  data: {
    type: 'test',
    title: 'Test Notification',
    body: 'Push notifications are working!',
    action: 'test',
  },
  token: token,
  android: {
    priority: 'high',
  },
};

console.log('Sending test notification...');

admin.messaging().send(message)
  .then((response) => {
    console.log('Successfully sent message:', response);
    process.exit(0);
  })
  .catch((error) => {
    console.log('Error sending message:', error);
    process.exit(1);
  });
