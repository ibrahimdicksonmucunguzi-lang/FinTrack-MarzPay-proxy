const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const MARZPAY_BASE = 'https://wallet.wearemarz.com/api/v1';
const MARZPAY_AUTH = 'bWFyel9TTmdZMHRwb1FVcFk1WmNoOndIRWdTT0lhUjhCUjNMMDV2NlZFUHFzMTBOZFdNZzU4';
const PROXY_SECRET = 'fintrack_marzpay_2025_proxy_key';
const MIN_AMOUNT = 500;
const MAX_AMOUNT = 10000000;

// In-memory OTP store: phone -> { code, expiry }
const otpStore = {};

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Key, Cache-Control, Pragma');
  res.header('Cache-Control', 'no-store, no-cache');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Auth middleware ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.headers['x-proxy-key'];
  if (key !== PROXY_SECRET) {
    return res.status(403).json({ status: 'error', message: 'Unauthorized' });
  }
  next();
});

const marzHeaders = {
  'Authorization': `Basic ${MARZPAY_AUTH}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'Cache-Control': 'no-cache',
};

// ── Keep-alive: ping every 14 min to prevent Render free tier sleep ───────────
setInterval(() => {
  require('http').get(`http://localhost:${process.env.PORT || 3000}/health`, () => {});
}, 14 * 60 * 1000);

// ── OTP helpers ───────────────────────────────────────────────────────────────
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendEgoSms(phone, message) {
  const number = phone.replace('+', '').replace(/\s/g, '');
  const url = `https://www.egosms.co/api/v1/plain/?number=${number}&message=${encodeURIComponent(message)}&username=INFINITECH&password=${encodeURIComponent('Moses,123##')}&sender=FinTrack`;
  try {
    const r = await axios.get(url, { timeout: 10000 });
    console.log(`[SMS] Sent to ${phone}: ${r.status} ${r.data}`);
    return true;
  } catch (e) {
    console.error(`[SMS] Failed to ${phone}:`, e.message);
    return false;
  }
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (_, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    res.json({ status: 'ok', outgoing_ip: r.data.ip, service: 'FinTrack MarzPay Proxy' });
  } catch {
    res.json({ status: 'ok', service: 'FinTrack MarzPay Proxy' });
  }
});

// ── Phone verification ────────────────────────────────────────────────────────
// Verify a phone number and get the registered name via Marz Pay
app.post('/verify-phone', async (req, res) => {
  const { phone_number } = req.body;
  if (!phone_number) {
    return res.json({ success: false, message: 'phone_number is required' });
  }

  
  // Marz Pay expects format: 256XXXXXXXXX (no +)
  const normalized = phone_number.replace('+', '').replace(/\s/g, '');

  try {
    console.log(`[VERIFY-PHONE] Verifying: ${normalized}`);
    const r = await axios.post(
      `${MARZPAY_BASE}/phone-verification/verify`,
      { phone_number: normalized },
      { headers: marzHeaders, timeout: 15000 }
    );
    console.log(`[VERIFY-PHONE] Response:`, JSON.stringify(r.data));
    res.json(r.data);
  } catch (e) {
    console.error('[VERIFY-PHONE] Error:', e.message, e.response?.data);
    res.json(e.response?.data ?? { success: false, message: e.message });
  }
});

// ── Send OTP to registered phone ──────────────────────────────────────────────
// Called before a withdrawal — sends OTP to the user's registered phone
app.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.json({ success: false, message: 'phone is required' });

  const code = generateOtp();
  otpStore[phone] = {
    code,
    expiry: Date.now() + 10 * 60 * 1000, // 10 minutes
  };

  const message = `FinTrack withdrawal OTP: ${code}. Valid for 10 minutes. Do not share.`;
  const sent = await sendEgoSms(phone, message);

  console.log(`[OTP] Code for ${phone}: ${code} (sent: ${sent})`);

  // Always return success — SMS is fire-and-forget
  res.json({ success: true, message: 'OTP sent to your registered number.' });
});

// ── Verify OTP ────────────────────────────────────────────────────────────────
app.post('/verify-otp', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) {
    return res.json({ success: false, message: 'phone and code are required' });
  }

  const entry = otpStore[phone];
  if (!entry) {
    return res.json({ success: false, message: 'No OTP found. Please request a new one.' });
  }
  if (Date.now() > entry.expiry) {
    delete otpStore[phone];
    return res.json({ success: false, message: 'OTP expired. Please request a new one.' });
  }
  if (entry.code !== code.trim()) {
    return res.json({ success: false, message: 'Incorrect OTP. Please try again.' });
  }

  delete otpStore[phone]; // single-use
  res.json({ success: true, message: 'OTP verified successfully.' });
});

// ── Collect (deposit / mobile money in) ──────────────────────────────────────
app.post('/collect', async (req, res) => {
  const { amount, phone_number } = req.body;

  // Validate amount
  if (!amount || amount < MIN_AMOUNT) {
    return res.json({
      status: 'error',
      message: `Minimum amount is UGX ${MIN_AMOUNT.toLocaleString()}.`,
    });
  }
  if (amount > MAX_AMOUNT) {
    return res.json({
      status: 'error',
      message: `Maximum amount is UGX ${MAX_AMOUNT.toLocaleString()}.`,
    });
  }

  try {
    console.log('[COLLECT] Request:', JSON.stringify(req.body));
    const r = await axios.post(`${MARZPAY_BASE}/collect-money`, req.body, {
      headers: marzHeaders,
      timeout: 30000,
    });
    console.log('[COLLECT] Response:', JSON.stringify(r.data));
    res.json(r.data);
  } catch (e) {
    console.error('[COLLECT] Error:', e.message, e.response?.data);
    res.json(e.response?.data ?? { status: 'error', message: e.message });
  }
});

// ── Send money (withdrawal / disbursement) ────────────────────────────────────
// Requires OTP to have been verified before calling this
app.post('/send', async (req, res) => {
  const { amount, phone_number, otp_verified } = req.body;

  // Must confirm OTP was verified
  if (!otp_verified) {
    return res.json({
      status: 'error',
      message: 'OTP verification required before withdrawal.',
    });
  }

  // Validate amount
  if (!amount || amount < MIN_AMOUNT) {
    return res.json({
      status: 'error',
      message: `Minimum withdrawal is UGX ${MIN_AMOUNT.toLocaleString()}.`,
    });
  }
  if (amount > MAX_AMOUNT) {
    return res.json({
      status: 'error',
      message: `Maximum withdrawal is UGX ${MAX_AMOUNT.toLocaleString()}.`,
    });
  }

  // Remove otp_verified from body before forwarding to Marz Pay
  const { otp_verified: _, ...marzBody } = req.body;

  try {
    console.log('[SEND] Request:', JSON.stringify(marzBody));
    const r = await axios.post(`${MARZPAY_BASE}/send-money`, marzBody, {
      headers: marzHeaders,
      timeout: 30000,
    });
    console.log('[SEND] Response:', JSON.stringify(r.data));
    res.json(r.data);
  } catch (e) {
    console.error('[SEND] Error:', e.message, e.response?.data);
    res.json(e.response?.data ?? { status: 'error', message: e.message });
  }
});

// ── Collection status ─────────────────────────────────────────────────────────
app.get('/status/:uuid', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const url = `${MARZPAY_BASE}/collect-money/${req.params.uuid}?_t=${Date.now()}`;
    const r = await axios.get(url, {
      headers: { ...marzHeaders, 'Cache-Control': 'no-cache, no-store' },
      timeout: 15000,
    });
    res.json(r.data);
  } catch (e) {
    res.json(e.response?.data ?? { status: 'error', message: e.message });
  }
});

// ── Send money status ─────────────────────────────────────────────────────────
app.get('/send-status/:uuid', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const url = `${MARZPAY_BASE}/send-money/${req.params.uuid}?_t=${Date.now()}`;
    const r = await axios.get(url, {
      headers: { ...marzHeaders, 'Cache-Control': 'no-cache, no-store' },
      timeout: 15000,
    });
    res.json(r.data);
  } catch (e) {
    res.json(e.response?.data ?? { status: 'error', message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FinTrack MarzPay proxy running on port ${PORT}`));
