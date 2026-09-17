//IMPORT THE PACKAGES
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { pool } from './db.js';
// Create the API on the same port used by the setup guide.
const app = express();
const port = Number(process.env.PORT || 5000);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const allowedOrigins = (process.env.FRONTEND_URL || 'https://easyorderdemo.netlify.app,http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
// CONNECT BACKEND APP WITH FRONTEND USING CORS
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'store';

async function uniqueUsername(email) {
  const base = slugify(email.split('@')[0]);
  let username = base;
  let index = 1;
  while (true) {
    const [rows] = await pool.query('SELECT id FROM sellers WHERE username = ?', [username]);
    if (!rows.length) return username;
    username = `${base}-${index++}`;
  }
}

async function verifySeller(credential) {
  if (!credential) throw new Error('Google credential is required');
  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new Error('Invalid Google identity');
  return payload;
}

function normalizeRwandaPhone(value) {
  let phone = String(value || '').replace(/\s+/g, '');
  if (phone.startsWith('+250')) phone = `0${phone.slice(4)}`;
  if (phone.startsWith('250')) phone = `0${phone.slice(3)}`;
  if (!/^07[2389]\d{7}$/.test(phone)) throw new Error('Enter a valid Rwanda MoMo number');
  return phone;
}

async function requireSeller(req, res, next) {
  try {
    const authorization = req.headers.authorization || '';
    const credential = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : req.body.credential;
    const identity = await verifySeller(credential);
    const [sellers] = await pool.query('SELECT id, google_id, email, name, avatar_url, username, momo_number FROM sellers WHERE google_id = ?', [identity.sub]);
    if (!sellers.length) return res.status(401).json({ success: false, message: 'Seller account not found' });
    req.seller = sellers[0];
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: error.message });
  }
}


// Paystack payment and payout helpers.
const paystackHeaders = () => ({ Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' });

async function initializePayment({ reference, amount, phone, name, email }) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    console.warn(`[payment] PAYSTACK_SECRET_KEY missing; ${reference} remains pending for local development.`);
    return { status: true, data: { reference, skipped: true } };
  }
  const response = await axios.post('https://api.paystack.co/transaction/initialize', {
    reference,
    amount: Math.round(amount * 100),
    currency: 'RWF',
    email: email || `${phone}@easyorder.rw`,
    channels: ['mobile_money'],
    metadata: { buyer_name: name, buyer_phone: phone },
  }, { headers: paystackHeaders() });
  return response.data;
}

async function createTransferRecipient({ name, phone, email }) {
  if (!process.env.PAYSTACK_SECRET_KEY || !phone) return null;
  const response = await axios.post('https://api.paystack.co/transferrecipient', {
    type: 'mobile_money',
    name,
    email,
    account_number: phone,
    bank_code: process.env.PAYSTACK_RWANDA_BANK_CODE || 'MTN',
    currency: 'RWF',
  }, { headers: paystackHeaders() });
  return response.data?.data?.recipient_code || null;
}

async function transferSellerPayout({ recipient, amount, reference }) {
  if (!recipient || !process.env.PAYSTACK_SECRET_KEY || !amount) return null;
  const response = await axios.post('https://api.paystack.co/transfer', {
    source: 'balance', amount: Math.round(amount * 100), currency: 'RWF', recipient, reason: `Easy Order ${reference}`,
  }, { headers: paystackHeaders() });
  return response.data;
}
//CHECK THE API
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ success: true, database: 'connected' });
  } catch {
    res.status(503).json({ success: false, database: 'unavailable' });
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const identity = await verifySeller(req.body.credential);
    const [existing] = await pool.query('SELECT id, google_id, email, name, avatar_url, username, momo_number FROM sellers WHERE google_id = ?', [identity.sub]);
    if (existing.length) return res.json({ success: true, seller: existing[0] });

    const username = await uniqueUsername(identity.email);
    const [result] = await pool.query(
      'INSERT INTO sellers (google_id, email, name, avatar_url, username) VALUES (?, ?, ?, ?, ?)',
      [identity.sub, identity.email, identity.name || identity.email.split('@')[0], identity.picture || null, username],
    );
    const [created] = await pool.query('SELECT id, google_id, email, name, avatar_url, username, momo_number FROM sellers WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, seller: created[0] });
  } catch (error) {
    res.status(401).json({ success: false, message: error.message });
  }
});


app.get('/api/me', requireSeller, async (req, res) => {
  const [products] = await pool.query('SELECT id, name, price_rwf, image_url, is_active, created_at FROM products WHERE seller_id = ? ORDER BY created_at DESC', [req.seller.id]);
  const [orders] = await pool.query('SELECT id, buyer_name, buyer_phone, delivery_address, items_json, total_amount, payment_status, reference, created_at FROM orders WHERE seller_id = ? ORDER BY created_at DESC LIMIT 12', [req.seller.id]);
  const [summary] = await pool.query('SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN payment_status = \'paid\' THEN total_amount ELSE 0 END), 0) AS revenue FROM orders WHERE seller_id = ?', [req.seller.id]);
  res.json({ success: true, seller: req.seller, products, orders, summary: summary[0], store_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/store/${req.seller.username}` });
});

app.post('/api/seller/payout-recipient', requireSeller, async (req, res) => {
  const phone = normalizeRwandaPhone(req.body.momo_number);
  const recipient = await createTransferRecipient({ name: req.seller.name, phone, email: req.seller.email });
  await pool.query('UPDATE sellers SET momo_number = ?, paystack_recipient_code = ? WHERE id = ?', [phone, recipient, req.seller.id]);
  res.json({ success: true, recipient_code: recipient, momo_number: phone });
});

app.get('/api/store/:username', async (req, res) => {
  const [sellers] = await pool.query('SELECT id, name, avatar_url, username FROM sellers WHERE username = ?', [req.params.username]);
  if (!sellers.length) return res.status(404).json({ success: false, message: 'Store not found' });
  const [products] = await pool.query('SELECT id, name, price_rwf, image_url, created_at FROM products WHERE seller_id = ? AND is_active = TRUE ORDER BY created_at DESC', [sellers[0].id]);
  res.json({ success: true, seller: sellers[0], products });
});
//ADD NEW ITEM TO THE STORE
app.post('/api/products', requireSeller, async (req, res) => {
  const { name, price_rwf: priceRwf, image_url: imageUrl } = req.body;
  const sellerId = req.seller.id;
  if (!name?.trim() || !Number.isInteger(Number(priceRwf)) || Number(priceRwf) < 1) return res.status(400).json({ success: false, message: 'Product name and a valid RWF price are required' });
  const [result] = await pool.query('INSERT INTO products (seller_id, name, price_rwf, image_url) VALUES (?, ?, ?, ?)', [sellerId, name.trim(), Number(priceRwf), imageUrl || null]);
  res.status(201).json({ success: true, product: { id: result.insertId, seller_id: sellerId, name, price_rwf: Number(priceRwf), image_url: imageUrl || null } });
});
//ORDER CHECKOUT
// ORDER CHECKOUT
app.post('/api/checkout', async (req, res) => {
  try {
    const { seller_id, buyer_name, buyer_phone, delivery_address, items } = req.body;

    // 1. Validate required fields
    if (!seller_id || !buyer_name?.trim() || !buyer_phone?.trim() || !delivery_address?.trim() || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing or invalid checkout information' });
    }

    // 2. Validate and normalize the buyer's Rwandan phone number
    let normalizedPhone;
    try {
      normalizedPhone = normalizeRwandaPhone(buyer_phone);
    } catch (phoneError) {
      return res.status(400).json({ success: false, message: phoneError.message });
    }

    // 3. Calculate total price from the items array
    let totalAmount = 0;
    for (const item of items) {
      const price = Number(item.price_rwf || item.price);
      const qty = Number(item.quantity || item.qty || 1);
      if (isNaN(price) || price < 1) {
        return res.status(400).json({ success: false, message: `Invalid price for item: ${item.name || 'Unknown'}` });
      }
      totalAmount += price * qty;
    }

    if (totalAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Total order amount must be greater than 0 RWF' });
    }

    // 4. Generate a secure, unique payment reference string
    const reference = `RWF-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

    // 5. Save the order to the database with a 'pending' payment status
    const itemsJson = JSON.stringify(items);
    await pool.query(
      'INSERT INTO orders (seller_id, buyer_name, buyer_phone, delivery_address, items_json, total_amount, payment_status, reference) VALUES (?, ?, ?, ?, ?, ?, \'pending\', ?)',
      [seller_id, buyer_name.trim(), normalizedPhone, delivery_address.trim(), itemsJson, totalAmount, reference]
    );

    // 6. Initialize Paystack Mobile Money Transaction
    const paymentResponse = await initializePayment({
      reference,
      amount: totalAmount,
      phone: normalizedPhone,
      name: buyer_name.trim(),
      email: `${normalizedPhone}@easyorder.rw` // Custom fallback email for Paystack requirement
    });

    // 7. Handle Paystack's initialization response
    if (paymentResponse && paymentResponse.status) {
      return res.status(201).json({
        success: true,
        message: 'Order created and payment initialized successfully',
        reference,
        total_amount: totalAmount,
        paystack_data: paymentResponse.data
      });
    } else {
      // If Paystack fails to initialize, log it but let frontend know order is placed locally
      console.error('[checkout] Paystack integration failed to initialize:', paymentResponse);
      return res.status(201).json({
        success: true,
        message: 'Order created locally, but payment gateway initialization failed.',
        reference,
        total_amount: totalAmount,
        paystack_data: null
      });
    }

  } catch (error) {
    console.error('[checkout] Error processing order:', error);
    res.status(500).json({ success: false, message: 'Internal server error processing checkout' });
  }
});


app.get('/api/orders/:reference/status', async (req, res) => {
  const [orders] = await pool.query('SELECT payment_status FROM orders WHERE reference = ?', [req.params.reference]);
  if (!orders.length) return res.status(404).json({ success: false, message: 'Order not found' });
  res.json({ success: true, payment_status: orders[0].payment_status });
});

//MOMO WEBHOOK

app.post('/api/webhook/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const expected = crypto.createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY || '').update(JSON.stringify(req.body)).digest('hex');
  if (!signature || signature !== expected) return res.status(401).json({ success: false, message: 'Unauthorized webhook signature' });
  const { event, data } = req.body;
  if (event === 'charge.success' && data?.reference) {
    const [result] = await pool.query('UPDATE orders SET payment_status = \'paid\' WHERE reference = ?', [data.reference]);
    if (result.affectedRows) {
      const [orders] = await pool.query('SELECT orders.*, sellers.paystack_recipient_code FROM orders JOIN sellers ON sellers.id = orders.seller_id WHERE orders.reference = ?', [data.reference]);
      const order = orders[0];
      if (order?.paystack_recipient_code) {
        const fee = Number(process.env.PLATFORM_FEE_PERCENT || 0);
        await transferSellerPayout({ recipient: order.paystack_recipient_code, amount: Number(order.total_amount) * (1 - fee / 100), reference: order.reference });
      }
      if (order) console.log(`EASY ORDER ${order.reference}\nCustomer: ${order.buyer_name}\nPhone: ${order.buyer_phone}\nAddress: ${order.delivery_address}\nTotal: RWF ${Number(order.total_amount).toLocaleString()}`);
    }
  }
  res.json({ received: true });
});
//CHECKING ERROR

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ success: false, message: 'Something went wrong' });
});

app.listen(port, () => console.log(`Kigali MoMo Store API running on http://localhost:${port}`));
