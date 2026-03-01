import Stripe from 'stripe';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function initFirebase() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

async function getRawBody(req) {
  if (typeof req.text === 'function') return Buffer.from(await req.text());
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function getUidByCustomerId(db, customerId) {
  const snapshot = await db
    .collection('users')
    .where('stripeCustomerId', '==', customerId)
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  return snapshot.docs[0].id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const buf = await getRawBody(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('constructEvent error:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  const db = initFirebase();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer;
        const uid = await getUidByCustomerId(db, customerId);
        if (uid) {
          if (session.metadata?.type === 'tip') {
            // Tip/donation: record in subcollection, don't change plan
            await db.collection(`users/${uid}/tips`).add({
              amount: session.amount_total,
              currency: session.currency,
              stripeSessionId: session.id,
              createdAt: Date.now(),
            });
          } else {
            // Pro plan purchase (existing behavior)
            await db.doc(`users/${uid}`).set({
              plan: 'pro',
              purchasedAt: Date.now(),
            }, { merge: true });
          }
        }
        break;
      }
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (e) {
    console.error(`Error handling ${event.type}:`, e);
    return res.status(500).send('Internal error');
  }

  res.json({ received: true });
}
