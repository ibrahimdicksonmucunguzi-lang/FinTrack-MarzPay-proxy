const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const MARZPAY_BASE = 'https://wallet.wearemarz.com/api/v1';
const MARZPAY_AUTH = 'bWFyel9TTmdZMHRwb1FVcFk1WmNoOndIRWdTT0lhUjhCUjNMMDV2NlZFUHFzMTBOZFdNZzU4';

// Proxy secret — Flutter app must send this in X-Proxy-Key header
const PROXY_SECRET = 'fintrack_marzpay_2025_proxy_key';

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

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (_, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json');
    res.json({ status: 'ok', outgoing_ip: r.data.ip, service: 'FinTrack MarzPay Proxy' });
  } catch {
    res.json({ status: 'ok', service: 'FinTrack MarzPay Proxy' });
  }
});

// ── Collect (mobile money deposit) ───────────────────────────────────────────
app.post('/collect', async (req, res) => {
  try {
    console.log('[COLLECT] Request:', JSON.stringify(req.body));
    const r = await axios.post(`${MARZPAY_BASE}/collect-money`, req.body, { headers: marzHeaders });
    console.log('[COLLECT] Response:', JSON.stringify(r.data));
    res.json(r.data);
  } catch (e) {
    console.error('[COLLECT] Error:', e.message, e.response?.data);
    res.json(e.response?.data ?? { status: 'error', message: e.message });
  }
});

// ── Collection status ─────────────────────────────────────────────────────────
app.get('/status/:uuid', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  try {
    const url = `${MARZPAY_BASE}/collect-money/${req.params.uuid}?_t=${Date.now()}`;
    const r = await axios.get(url, {
      headers: { ...marzHeaders, 'Cache-Control': 'no-cache, no-store' },
    });
    res.json(r.data);
  } catch (e) {
    res.json(e.response?.data ?? { status: 'error', message: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FinTrack MarzPay proxy running on port ${PORT}`));
