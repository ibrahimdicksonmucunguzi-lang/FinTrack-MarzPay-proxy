const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const MARZPAY_BASE = 'https://wallet.wearemarz.com/api/v1';
const MARZPAY_AUTH = 'bWFyel9TTmdZMHRwb1FVcFk1WmNoOndIRWdTT0lhUjhCUjNMMDV2NlZFUHFzMTBOZFdNZzU4';
const PROXY_SECRET = 'fintrack_marzpay_2025_proxy_key';
const MIN_AMOUNT = 500;
const otpStore = {};

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Key, Cache-Control, Authorization');
  res.header('Access-Control-Max-Age', '86400'); // cache preflight for 24h
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  if (req.headers['x-proxy-key'] !== PROXY_SECRET)
    return res.status(403).json({ status: 'error', message: 'Unauthorized' });
  next();
});

function normalizePhone(raw) {
  let p = (raw || '').replace(/[\s\-\(\)]/g, '');
  if (p.startsWith('0')) return '+256' + p.substring(1);
  if (/^256/.test(p)) return '+' + p;
  if (!p.startsWith('+')) return '+256' + p;
  return p;
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeEgoPhone(raw) {
  // Ego SMS requires the number in format 256XXXXXXXXX (no + prefix)
  let p = (raw || '').replace(/[\s\-\(\)\+]/g, '');
  if (p.startsWith('0')) return '256' + p.substring(1);       // 0758... → 256758...
  if (p.startsWith('256')) return p;                           // already correct
  if (p.length === 9) return '256' + p;                       // bare 9 digits
  return '256' + p;                                           // fallback
}

async function sendEgoSms(phone, message) {
  const number = normalizeEgoPhone(phone);
  // Ego SMS does NOT return HTTP 200 — it returns a numeric ID or "OK" in the body.
  // Treat any completed request as success (fire-and-forget style).
  const url = `https://www.egosms.co/api/v1/plain/?number=${number}&message=${encodeURIComponent(message)}&username=INFINITECH&password=${encodeURIComponent('Moses,123##')}&sender=FinTrack`;
  console.log(`[SMS] Sending to ${number}, url: ${url.substring(0, 80)}...`);
  try {
    const r = await axios.get(url, { timeout: 10000 });
    // Ego SMS success: body is a numeric ID (e.g. "1234567") or contains "OK"
    // It does NOT use HTTP 200 as a success indicator — just log and move on
    console.log(`[SMS] Ego response status=${r.status} body="${r.data}"`);
    return true; // always true — fire and forget
  } catch (e) {
    console.error('[SMS] Ego request failed:', e.message);
    return true; // still return true — SMS may have been queued
  }
}

setInterval(() => {
  require('http').get(`http://localhost:${process.env.PORT || 3000}/health`, () => {});
}, 14 * 60 * 1000);

app.get('/health', async (_, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    res.json({ status: 'ok', outgoing_ip: r.data.ip, service: 'FinTrack MarzPay Proxy' });
  } catch { res.json({ status: 'ok' }); }
});

app.post('/verify-phone', async (req, res) => {
  const normalized = (req.body.phone_number || '').replace('+', '').replace(/\s/g, '');
  try {
    const r = await axios.post(`${MARZPAY_BASE}/phone-verification/verify`,
      { phone_number: normalized },
      { headers: { 'Authorization': `Basic ${MARZPAY_AUTH}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    res.json(r.data);
  } catch (e) { res.json(e.response?.data ?? { success: false, message: e.message }); }
});

app.post('/send-otp', async (req, res) => {
  // Accept both field names for compatibility
  const registeredPhone = req.body.registeredPhone || req.body.phone || '';
  console.log(`[OTP] /send-otp body:`, JSON.stringify(req.body));
  console.log(`[OTP] resolved phone: "${registeredPhone}"`);

  if (!registeredPhone) {
    console.error('[OTP] No phone field found in body');
    return res.json({ success: false, message: 'registeredPhone required' });
  }

  const code = generateOtp();
  otpStore[registeredPhone] = { code, expiry: Date.now() + 120000 }; // 2 min
  console.log(`[OTP] Code for ${registeredPhone}: ${code} (expires in 2 min)`);

  // Fire and forget — Ego SMS has no reliable status code
  sendEgoSms(
    registeredPhone,
    `FinTrack code: ${code}. Valid 2 min. Do NOT share.`
  ).then(sent => {
    console.log(`[OTP] sendEgoSms returned: ${sent}`);
  });

  // Respond immediately — don't wait for SMS delivery
  res.json({ success: true, message: 'OTP sent to your registered number.' });
});

app.post('/verify-otp', async (req, res) => {
  const { phone, registeredPhone, code } = req.body;
  const lookupPhone = registeredPhone || phone;
  const entry = otpStore[lookupPhone];
  if (!entry) return res.json({ success: false, message: 'No OTP found. Request a new one.' });
  if (Date.now() > entry.expiry) {
    delete otpStore[lookupPhone];
    return res.json({ success: false, message: 'OTP expired. Request a new one.' });
  }
  if (entry.code !== (code || '').trim()) return res.json({ success: false, message: 'Incorrect OTP.' });
  delete otpStore[lookupPhone];
  res.json({ success: true, message: 'OTP verified.' });
});

app.post('/collect', async (req, res) => {
  const { amount, phone_number, country, reference, description } = req.body;
  if (!amount || amount < MIN_AMOUNT) return res.json({ status: 'error', message: `Minimum is UGX ${MIN_AMOUNT}.` });
  // MarzPay collect-money expects phone WITHOUT leading '+' (e.g. 256712345678)
  const phone = normalizePhone(phone_number).replace('+', '');
  const params = new URLSearchParams();
  params.append('phone_number', phone);
  params.append('amount', String(amount));
  params.append('country', country || 'UG');
  params.append('reference', reference);
  if (description) params.append('description', description);
  console.log('[COLLECT] phone:', phone, 'amount:', amount);
  try {
    const r = await axios.post(`${MARZPAY_BASE}/collect-money`, params.toString(), {
      headers: { 'Authorization': `Basic ${MARZPAY_AUTH}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      timeout: 30000
    });
    console.log('[COLLECT]', JSON.stringify(r.data));
    res.json(r.data);
  } catch (e) { res.json(e.response?.data ?? { status: 'error', message: e.message }); }
});

app.post('/send', async (req, res) => {
  const { amount, phone_number, otp_verified, country, reference, description } = req.body;
  if (!otp_verified) return res.json({ status: 'error', message: 'OTP verification required.' });
  if (!amount || amount < MIN_AMOUNT) return res.json({ status: 'error', message: `Minimum is UGX ${MIN_AMOUNT}.` });
  // MarzPay send-money expects phone WITHOUT leading '+' (e.g. 256712345678)
  const phone = normalizePhone(phone_number).replace('+', '');
  const params = new URLSearchParams();
  params.append('phone_number', phone);
  params.append('amount', String(amount));
  params.append('country', country || 'UG');
  params.append('reference', reference);
  if (description) params.append('description', description);
  console.log('[SEND] phone:', phone, 'amount:', amount);
  try {
    const r = await axios.post(`${MARZPAY_BASE}/send-money`, params.toString(), {
      headers: { 'Authorization': `Basic ${MARZPAY_AUTH}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      timeout: 30000
    });
    console.log('[SEND]', JSON.stringify(r.data));
    res.json(r.data);
  } catch (e) { res.json(e.response?.data ?? { status: 'error', message: e.message }); }
});

app.get('/status/:uuid', async (req, res) => {
  try {
    const r = await axios.get(`${MARZPAY_BASE}/collect-money/${req.params.uuid}`,
      { headers: { 'Authorization': `Basic ${MARZPAY_AUTH}` }, timeout: 15000 });
    res.json(r.data);
  } catch (e) { res.json(e.response?.data ?? { status: 'error', message: e.message }); }
});

app.get('/send-status/:uuid', async (req, res) => {
  try {
    const r = await axios.get(`${MARZPAY_BASE}/send-money/${req.params.uuid}`,
      { headers: { 'Authorization': `Basic ${MARZPAY_AUTH}` }, timeout: 15000 });
    res.json(r.data);
  } catch (e) { res.json(e.response?.data ?? { status: 'error', message: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FinTrack MarzPay proxy on port ${PORT}`));
