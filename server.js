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
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
for (const origin of ['https://easyorderdemo.netlify.app', 'http://localhost:5173']) {
  if (!allowedOrigins.includes(origin)) allowedOrigins.push(origin);
}
// CONNECT BACKEND APP WITH FRONTEND USING CORS
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204,
}));
app.use(express.json());
app.use((req, _res, next) => {
  req.body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  next();
});

async function ensureDatabaseSchema() {
  const createTableQueries = [
    `CREATE TABLE IF NOT EXISTS sellers (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      google_id VARCHAR(255) NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(150) NOT NULL,
      avatar_url VARCHAR(500),
      username VARCHAR(80) NOT NULL UNIQUE,
      momo_number VARCHAR(20),
      paystack_recipient_code VARCHAR(120),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS products (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      seller_id INT UNSIGNED NOT NULL,
      name VARCHAR(160) NOT NULL,
      price_rwf INT UNSIGNED NOT NULL,
      image_url VARCHAR(500),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_products_seller FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS orders (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      seller_id INT UNSIGNED NOT NULL,
      buyer_name VARCHAR(150) NOT NULL,
      buyer_phone VARCHAR(20) NOT NULL,
      delivery_address VARCHAR(500) NOT NULL,
      items_json JSON NOT NULL,
      total_amount INT UNSIGNED NOT NULL,
      payment_status ENUM('pending', 'paid', 'failed') NOT NULL DEFAULT 'pending',
      reference VARCHAR(120) NOT NULL UNIQUE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_orders_seller FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,
  ];

  for (const query of createTableQueries) await pool.query(query);

  const repairQueries = [
    'ALTER TABLE sellers ADD COLUMN paystack_recipient_code VARCHAR(120)',
    'ALTER TABLE products ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE',
    'ALTER TABLE sellers MODIFY COLUMN id INT UNSIGNED NOT NULL AUTO_INCREMENT',
    'ALTER TABLE products MODIFY COLUMN id INT UNSIGNED NOT NULL AUTO_INCREMENT',
    'ALTER TABLE orders MODIFY COLUMN id INT UNSIGNED NOT NULL AUTO_INCREMENT',
  ];
  for (const query of repairQueries) {
    try {
      await pool.query(query);
    } catch (error) {
      const duplicateColumn = error.code === 'ER_DUP_FIELDNAME' || error.code === 'ER_DUP_COLUMN_NAME';
      if (!duplicateColumn) console.warn(`[database] Repair skipped: ${error.message}`);
    }
  }
  console.log('[database] Schema ready');
}

const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'store';

async function nextId(table) {
  const allowedTables = new Set(['sellers', 'products', 'orders']);
  if (!allowedTables.has(table)) throw new Error(`Unsupported table for id generation: ${table}`);
  const [rows] = await pool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM ${table}`);
  return Number(rows[0].nextId);
}

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
      : req.body?.credential;
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
    const sellerId = await nextId('sellers');
    const [result] = await pool.query(
      'INSERT INTO sellers (id, google_id, email, name, avatar_url, username) VALUES (?, ?, ?, ?, ?, ?)',
      [sellerId, identity.sub, identity.email, identity.name || identity.email.split('@')[0], identity.picture || null, username],
    );
    const [created] = await pool.query('SELECT id, google_id, email, name, avatar_url, username, momo_number FROM sellers WHERE id = ?', [sellerId]);
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
  try {
    const phone = normalizeRwandaPhone(req.body.momo_number);
    const recipient = await createTransferRecipient({ name: req.seller.name, phone, email: req.seller.email });
    await pool.query('UPDATE sellers SET momo_number = ?, paystack_recipient_code = ? WHERE id = ?', [phone, recipient, req.seller.id]);
    res.json({ success: true, recipient_code: recipient, momo_number: phone });
  } catch (error) {
    const status = error.message === 'Enter a valid Rwanda MoMo number' ? 400 : 500;
    console.error('[payout-recipient] Error:', error);
    res.status(status).json({ success: false, message: error.message || 'Unable to save payout number' });
  }
});

app.get('/api/store/:username', async (req, res) => {
  const [sellers] = await pool.query('SELECT id, name, avatar_url, username FROM sellers WHERE username = ?', [req.params.username]);
  if (!sellers.length) return res.status(404).json({ success: false, message: 'Store not found' });
  const [products] = await pool.query('SELECT id, name, price_rwf, image_url, created_at FROM products WHERE seller_id = ? AND is_active = TRUE ORDER BY created_at DESC', [sellers[0].id]);
  res.json({ success: true, seller: sellers[0], products });
});
//ADD NEW ITEM TO THE STORE
app.post('/api/products', requireSeller, async (req, res) => {
  try {
    const { name, price_rwf: priceRwf, image_url: imageUrl } = req.body || {};
    const sellerId = req.seller.id;
    if (typeof name !== 'string' || !name.trim() || !Number.isInteger(Number(priceRwf)) || Number(priceRwf) < 1) return res.status(400).json({ success: false, message: 'Product name and a valid RWF price are required' });
    const productId = await nextId('products');
    await pool.query('INSERT INTO products (id, seller_id, name, price_rwf, image_url) VALUES (?, ?, ?, ?, ?)', [productId, sellerId, name.trim(), Number(priceRwf), imageUrl || null]);
    res.status(201).json({ success: true, product: { id: productId, seller_id: sellerId, name, price_rwf: Number(priceRwf), image_url: imageUrl || null } });
  } catch (error) {
    console.error('[products] Error creating product:', error);
    res.status(500).json({ success: false, message: error.message || 'Unable to create product' });
  }
});
//ORDER CHECKOUT
// ORDER CHECKOUT
app.post('/api/checkout', async (req, res) => {
  try {
    const { seller_id, buyer_name, buyer_phone, delivery_address, items } = req.body;

    // 1. Validate required fields
    if (!seller_id || typeof buyer_name !== 'string' || !buyer_name.trim() || typeof buyer_phone !== 'string' || !buyer_phone.trim() || typeof delivery_address !== 'string' || !delivery_address.trim() || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Missing or invalid checkout information' });
    }

    const [sellers] = await pool.query('SELECT id FROM sellers WHERE id = ?', [seller_id]);
    if (!sellers.length) return res.status(404).json({ success: false, message: 'Seller not found' });

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
      if (!item || typeof item !== 'object') {
        return res.status(400).json({ success: false, message: 'Invalid checkout item' });
      }
      const price = Number(item.price_rwf || item.price);
      const qty = Number(item.quantity || item.qty || 1);
      if (!Number.isInteger(price) || price < 1 || !Number.isInteger(qty) || qty < 1) {
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
    const orderId = await nextId('orders');
    await pool.query(
      'INSERT INTO orders (id, seller_id, buyer_name, buyer_phone, delivery_address, items_json, total_amount, payment_status, reference) VALUES (?, ?, ?, ?, ?, ?, ?, \'pending\', ?)',
      [orderId, seller_id, buyer_name.trim(), normalizedPhone, delivery_address.trim(), itemsJson, totalAmount, reference]
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
  const status = Number(error.status || error.statusCode) || 500;
  const message = status >= 500 ? 'Something went wrong' : error.message || 'Invalid request';
  res.status(status).json({ success: false, message });
});

ensureDatabaseSchema()
  .then(() => app.listen(port, () => console.log(` API running on${port}`)))
  .catch((error) => {
    console.error('[database] Schema initialization failed:', error);
    process.exitCode = 1;
  });
