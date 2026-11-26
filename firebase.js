const admin = require("firebase-admin");
require("dotenv").config();

let db = null;
let firestoreAtivo = false;

function inicializarFirebase() {
  if (firestoreAtivo && db) return db;
  try {
    const projectId = process.env.FIREBASE_PROJECT_ID || "clinica-forja";
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const rawKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!clientEmail || !rawKey) {
      return null;
    }

    const privateKey = rawKey.replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      });
    }

    db = admin.firestore();
    firestoreAtivo = true;
    return db;
  } catch (_) {
    return null;
  }
}

inicializarFirebase();

module.exports = {
  admin,
  getDb: () => db || inicializarFirebase(),
  isFirestoreAtivo: () => firestoreAtivo,
};
