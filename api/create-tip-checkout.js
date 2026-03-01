export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId, email, amount } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const tipAmount = parseInt(amount, 10);
  if (!tipAmount || tipAmount < 100 || tipAmount > 100000) {
    return res.status(400).json({ error: '金額は¥100〜¥100,000の範囲で指定してください' });
  }

  try {
    const { db } = initFirebase();
    const userDoc = await db.collection('users').doc(userId).get();
    let customerId = userDoc.exists ? userDoc.data().stripeCustomerId : null;

    // Create Stripe customer if needed
    if (!customerId) {
      const customerRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          'metadata[firebaseUID]': userId,
          ...(email ? { email } : {}),
        }),
      });
      const customer = await customerRes.json();
      if (!customerRes.ok) {
        return res.status(500).json({ error: customer.error?.message || 'Customer creation failed' });
      }
      customerId = customer.id;
      await db.collection('users').doc(userId).set({ stripeCustomerId: customerId }, { merge: true });
    }

    // Create Checkout Session (one-time tip payment with dynamic amount)
    async function createSession(custId) {
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          'customer': custId,
          'payment_method_types[]': 'card',
          'line_items[0][price_data][currency]': 'jpy',
          'line_items[0][price_data][unit_amount]': String(tipAmount),
          'line_items[0][price_data][product_data][name]': 'DoujinPOS 応援（投げ銭）',
          'line_items[0][quantity]': '1',
          'mode': 'payment',
          'success_url': `${process.env.APP_URL}?tip=success`,
          'cancel_url': `${process.env.APP_URL}?tip=canceled`,
          'payment_intent_data[metadata][firebaseUID]': userId,
          'metadata[type]': 'tip',
          'metadata[firebaseUID]': userId,
          'locale': 'ja',
        }),
      });
      return { response, session: await response.json() };
    }

    let { response, session } = await createSession(customerId);

    // If customer ID is stale (from a different Stripe account), recreate
    if (!response.ok && session.error?.type === 'invalid_request_error'
        && session.error?.message?.includes('No such customer')) {
      console.warn('Stale Stripe customer ID detected, recreating customer...');
      const customerRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          'metadata[firebaseUID]': userId,
          ...(email ? { email } : {}),
        }),
      });
      const newCustomer = await customerRes.json();
      if (!customerRes.ok) {
        return res.status(500).json({ error: newCustomer.error?.message || 'Customer recreation failed' });
      }
      customerId = newCustomer.id;
      await db.collection('users').doc(userId).set({ stripeCustomerId: customerId }, { merge: true });
      ({ response, session } = await createSession(customerId));
    }

    if (!response.ok) {
      console.error('Stripe API error:', JSON.stringify(session.error));
      return res.status(500).json({ error: session.error?.message || 'Stripe error' });
    }

    res.json({ url: session.url });
  } catch (e) {
    console.error('create-tip-checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

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
  return { db: getFirestore() };
}
