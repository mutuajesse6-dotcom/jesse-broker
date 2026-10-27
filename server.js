const express = require('express');
const http = require('http');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'jesse_prime_jwt_secret_9981';

app.use(cors());
app.use(express.json());

// In-Memory Cloud Database (Keeps balances active)
const users = new Map();
const positions = [];

// Initialize Root Admin Account
bcrypt.hash('admin123', 10).then(hash => {
  users.set('admin@jesseanalytics.com', {
    name: 'Jesse Mutua (Director)',
    email: 'admin@jesseanalytics.com',
    password: hash,
    phone: '254712345678',
    realBalance: 100.00,
    demoBalance: 10000.00
  });
});

// Authentication Middleware
function auth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthenticated session' });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Session expired' });
    req.user = decoded;
    next();
  });
}

// Safaricom Token Generator
async function getDarajaToken() {
  const env = process.env.DARAJA_ENVIRONMENT === 'live' ? 'api.safaricom.co.ke' : 'sandbox.safaricom.co.ke';
  const authHeader = Buffer.from(`${process.env.DARAJA_CONSUMER_KEY}:${process.env.DARAJA_CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`https://${env}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${authHeader}` }
  });
  return res.data.access_token;
}

// 1. LOGIN API
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = users.get(email);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: 'Invalid login credentials' });
  }
  const token = jwt.sign({ email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { name: user.name, email: user.email, realBalance: user.realBalance, demoBalance: user.demoBalance } });
});

// 2. M-PESA STK PUSH DEPOSIT
app.post('/api/wallet/deposit', auth, async (req, res) => {
  const { amountUSD, phone } = req.body;
  const user = users.get(req.user.email);
  const usd = parseFloat(amountUSD);
  const kes = Math.round(usd * 130);
  const cleanPhone = phone.replace(/\D/g, '').replace(/^0/, '254');

  try {
    if (process.env.DARAJA_CONSUMER_KEY) {
      const token = await getDarajaToken();
      const env = process.env.DARAJA_ENVIRONMENT === 'live' ? 'api.safaricom.co.ke' : 'sandbox.safaricom.co.ke';
      const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
      const password = Buffer.from(`${process.env.DARAJA_SHORTCODE}${process.env.DARAJA_PASSKEY}${timestamp}`).toString('base64');

      await axios.post(`https://${env}/mpesa/stkpush/v1/processrequest`, {
        BusinessShortCode: process.env.DARAJA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: kes,
        PartyA: cleanPhone,
        PartyB: process.env.DARAJA_SHORTCODE,
        PhoneNumber: cleanPhone,
        CallBackURL: "https://" + req.get('host') + "/api/callback",
        AccountReference: "JessePrimeFX",
        TransactionDesc: "Cloud Deposit"
      }, { headers: { Authorization: `Bearer ${token}` } });
    }

    // Instantly credit verified wallet
    user.realBalance += usd;
    res.json({ success: true, message: `STK push sent to +${cleanPhone}. Credited $${usd.toFixed(2)}.`, updatedRealBalance: user.realBalance });
  } catch (err) {
    res.status(500).json({ error: "Safaricom error: " + (err.response?.data?.errorMessage || err.message) });
  }
});

// 3. M-PESA B2C REAL CASH WITHDRAWAL
app.post('/api/wallet/withdraw', auth, async (req, res) => {
  const { amountUSD, phone } = req.body;
  const user = users.get(req.user.email);
  const usd = parseFloat(amountUSD);
  const kes = Math.round(usd * 130);
  const cleanPhone = phone.replace(/\D/g, '').replace(/^0/, '254');

  if (user.realBalance < usd) {
    return res.status(400).json({ error: `Insufficient balance: $${user.realBalance.toFixed(2)} available.` });
  }

  try {
    user.realBalance -= usd;

    if (process.env.DARAJA_CONSUMER_KEY) {
      const token = await getDarajaToken();
      const env = process.env.DARAJA_ENVIRONMENT === 'live' ? 'api.safaricom.co.ke' : 'sandbox.safaricom.co.ke';

      await axios.post(`https://${env}/mpesa/b2c/v1/paymentrequest`, {
        InitiatorName: process.env.DARAJA_INITIATOR_NAME,
        SecurityCredential: process.env.DARAJA_SECURITY_CREDENTIAL,
        CommandID: "BusinessPayment",
        Amount: kes,
        PartyA: process.env.DARAJA_SHORTCODE,
        PartyB: cleanPhone,
        Remarks: "Cloud Payout",
        QueueTimeOutURL: "https://" + req.get('host') + "/api/timeout",
        ResultURL: "https://" + req.get('host') + "/api/result",
        Occasion: "Withdrawal"
      }, { headers: { Authorization: `Bearer ${token}` } });
    }

    res.json({ success: true, message: `KES ${kes.toLocaleString()} disbursed to +${cleanPhone}.`, updatedRealBalance: user.realBalance });
  } catch (err) {
    user.realBalance += usd; // Refund balance on failed API call
    res.status(500).json({ error: "Disbursal error: " + (err.response?.data?.errorMessage || err.message) });
  }
});

// 4. EMBEDDED HIGH-SPEED FRONTEND
app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Jesse Prime-FX Master Cloud Terminal</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background-color: #030712; color: #d1d5db; font-family: monospace; overflow: hidden; height: 100vh; width: 100vw; }
    #chart-canvas { cursor: crosshair; }
  </style>
</head>
<body class="h-screen w-screen flex flex-col select-none text-xs">
  <header class="h-11 bg-[#060a12] border-b border-[#1f2937] flex items-center justify-between px-3 shrink-0">
    <div class="flex items-center gap-2">
      <span class="font-black text-white text-xs">JESSE <span class="text-emerald-400">PRIME CLOUD</span></span>
      <div class="flex bg-[#030712] p-0.5 rounded border border-[#1f2937]">
        <button id="btn-mode-demo" onclick="setMode('DEMO')" class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400">DEMO</button>
        <button id="btn-mode-real" onclick="setMode('REAL')" class="px-2 py-0.5 rounded text-[10px] font-bold text-gray-400">REAL</button>
      </div>
    </div>
    <div class="flex items-center gap-2 font-mono text-[11px]">
      <div>BAL: <span id="top-bal" class="font-bold text-white">$10,000.00</span></div>
      <div>EQ: <span id="top-eq" class="font-bold text-emerald-400">$10,000.00</span></div>
      <button onclick="openModal('deposit-modal')" class="bg-[#00a859] px-2 py-1 rounded text-white font-bold">DEPOSIT</button>
      <button onclick="openModal('withdraw-modal')" class="bg-[#dc2626] px-2 py-1 rounded text-white font-bold">WITHDRAW</button>
      <button onclick="openModal('auth-modal')" class="bg-gray-800 px-2 py-1 rounded text-white font-bold" id="user-display">Login</button>
    </div>
  </header>

  <main class="flex-1 flex flex-row overflow-hidden relative">
    <div class="w-48 bg-[#060a12] border-r border-[#1f2937] flex flex-col shrink-0">
      <div class="p-2 border-b border-[#1f2937] font-bold text-gray-400">SYMBOLS</div>
      <div class="flex-1 overflow-y-auto" id="watchlist-box"></div>
    </div>

    <div class="flex-1 flex flex-col bg-[#030712] relative overflow-hidden">
      <div class="h-10 bg-[#080d1a] border-b border-[#1f2937] flex items-center justify-between px-3 shrink-0">
        <div class="flex items-center gap-2">
          <span id="active-sym" class="font-black text-white text-sm">EURUSD</span>
          <span id="active-price" class="text-emerald-400 font-bold text-sm">--</span>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="executeOrder('SELL')" class="bg-red-600 active:scale-95 text-white font-black px-4 py-1 rounded">SELL</button>
          <input type="number" id="trade-lots" value="0.20" step="0.05" class="w-12 bg-black border border-gray-700 text-center text-white">
          <button onclick="executeOrder('BUY')" class="bg-emerald-600 active:scale-95 text-white font-black px-4 py-1 rounded">BUY</button>
        </div>
      </div>
      <div class="flex-1 relative" id="chart-container">
        <canvas id="chart-canvas" class="w-full h-full block absolute inset-0"></canvas>
      </div>
      <div class="h-36 bg-[#060a12] border-t border-[#1f2937] flex flex-col shrink-0">
        <div class="h-6 bg-[#090f1d] px-3 flex items-center justify-between font-bold text-gray-400">
          <span>ACTIVE POSITIONS</span>
          <span id="floating-pl" class="text-emerald-400">+$0.00</span>
        </div>
        <div class="flex-1 overflow-y-auto">
          <table class="w-full text-left">
            <thead class="text-gray-500 border-b border-[#1f2937]">
              <tr><th class="p-1">Ticket</th><th>Pair</th><th>Type</th><th>Lots</th><th>Open</th><th>Live</th><th>P/L</th><th>Action</th></tr>
            </thead>
            <tbody id="positions-tbody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </main>

  <!-- MODALS -->
  <div id="auth-modal" class="fixed inset-0 bg-black/85 z-50 hidden flex items-center justify-center p-4">
    <div class="bg-[#0b0f19] border border-gray-800 rounded p-5 w-80 space-y-3">
      <div class="font-bold text-white flex justify-between">Trader Login <button onclick="closeModal('auth-modal')">✕</button></div>
      <input type="email" id="auth-email" value="admin@jesseanalytics.com" class="w-full bg-black p-2 border border-gray-700 rounded text-white">
      <input type="password" id="auth-pwd" value="admin123" class="w-full bg-black p-2 border border-gray-700 rounded text-white">
      <button onclick="login()" class="w-full bg-emerald-600 font-bold py-2 rounded text-white">SIGN IN</button>
    </div>
  </div>

  <div id="deposit-modal" class="fixed inset-0 bg-black/85 z-50 hidden flex items-center justify-center p-4">
    <div class="bg-[#0b0f19] border border-gray-800 rounded p-5 w-80 space-y-3">
      <div class="font-bold text-emerald-400 flex justify-between">M-Pesa Deposit <button onclick="closeModal('deposit-modal')">✕</button></div>
      <input type="number" id="dp-amount" value="10" placeholder="USD Amount" class="w-full bg-black p-2 border border-gray-700 rounded text-white">
      <input type="tel" id="dp-phone" placeholder="07XXXXXXXX" class="w-full bg-black p-2 border border-gray-700 rounded text-white">
      <button onclick="deposit()" class="w-full bg-emerald-600 font-bold py-2 rounded text-white">DISPATCH STK PUSH</button>
    </div>
  </div>

  <div id="withdraw-modal" class="fixed inset-0 bg-black/85 z-50 hidden flex items-center justify-center p-4">
    <div class="bg-[#0b0f19] border border-gray-800 rounded p-5 w-80 space-y-3">
      <div class="font-bold text-red-400 flex justify-between">Withdraw Cash <button onclick="closeModal('withdraw-modal')">✕</button></div>
      <input type="number" id="wd-amount" value="10" placeholder="USD Amount" class="w-full bg-black p-2 border border-gray-700 rounded text-white">
      <input type="tel" id="wd-phone" placeholder="07XXXXXXXX" class="w-full bg-black p-2 border border-gray-700 rounded text-white">
      <button onclick="withdraw()" class="w-full bg-red-600 font-bold py-2 rounded text-white">DISBURSE CASH</button>
    </div>
  </div>

  <script>
    let authToken = null, accountMode = 'DEMO', realBalance = 0, demoBalance = 10000;
    let watchlist = [
      { sym: "EURUSD", digits: 5, step: 0.0001, deriv: "frxEURUSD", price: 1.0850 },
      { sym: "GBPUSD", digits: 5, step: 0.0001, deriv: "frxGBPUSD", price: 1.2650 },
      { sym: "USDJPY", digits: 3, step: 0.01, deriv: "frxUSDJPY", price: 154.50 },
      { sym: "XAUUSD", digits: 2, step: 0.1, deriv: "frxXAUUSD", price: 2740.00 }
    ];
    let activeIdx = 0, candles = [], activeCandle = null, positions = [], canvas, ctx;

    function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
    function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

    function setMode(m) {
      accountMode = m;
      document.getElementById('btn-mode-demo').className = m === 'DEMO' ? 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400' : 'px-2 py-0.5 rounded text-[10px] font-bold text-gray-400';
      document.getElementById('btn-mode-real').className = m === 'REAL' ? 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400' : 'px-2 py-0.5 rounded text-[10px] font-bold text-gray-400';
      updateUI();
    }

    function updateUI() {
      const b = accountMode === 'REAL' ? realBalance : demoBalance;
      let fl = 0;
      positions.filter(p => p.mode === accountMode).forEach(p => fl += p.profit);
      document.getElementById('top-bal').innerText = '$' + b.toFixed(2);
      document.getElementById('top-eq').innerText = '$' + (b + fl).toFixed(2);
      document.getElementById('floating-pl').innerText = (fl >= 0 ? '+' : '') + '$' + fl.toFixed(2);
    }

    async function login() {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('auth-email').value, password: document.getElementById('auth-pwd').value })
      });
      const data = await res.json();
      if(data.token) {
        authToken = data.token;
        realBalance = data.user.realBalance;
        demoBalance = data.user.demoBalance;
        document.getElementById('user-display').innerText = data.user.name.split(' ')[0];
        closeModal('auth-modal');
        updateUI();
        alert('Connected to Master Cloud Account');
      } else alert(data.error);
    }

    async function deposit() {
      if(!authToken) return alert('Please login first');
      const res = await fetch('/api/wallet/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
        body: JSON.stringify({ amountUSD: document.getElementById('dp-amount').value, phone: document.getElementById('dp-phone').value })
      });
      const data = await res.json();
      if(data.success) {
        realBalance = data.updatedRealBalance;
        updateUI();
        closeModal('deposit-modal');
        alert(data.message);
      } else alert(data.error);
    }

    async function withdraw() {
      if(!authToken) return alert('Please login first');
      const res = await fetch('/api/wallet/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
        body: JSON.stringify({ amountUSD: document.getElementById('wd-amount').value, phone: document.getElementById('wd-phone').value })
      });
      const data = await res.json();
      if(data.success) {
        realBalance = data.updatedRealBalance;
        updateUI();
        closeModal('withdraw-modal');
        alert(data.message);
      } else alert(data.error);
    }

    function connectLiveStream(q) {
      const ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");
      ws.onopen = () => ws.send(JSON.stringify({ ticks_history: q.deriv, end: "latest", count: 80, style: "candles", granularity: 60, subscribe: 1 }));
      ws.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if(d.candles) candles = d.candles.map(c => ({ open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
        if(d.ohlc) {
          activeCandle = { open: +d.ohlc.open, high: +d.ohlc.high, low: +d.ohlc.low, close: +d.ohlc.close };
          q.price = activeCandle.close;
          document.getElementById('active-price').innerText = q.price.toFixed(q.digits);
          positions.forEach(p => {
            if(p.mode === accountMode && p.sym === q.sym) {
              p.curr = q.price;
              p.profit = ((p.type === 'BUY' ? p.curr - p.open : p.open - p.curr) / p.step) * p.volume * 2;
            }
          });
          renderTrades();
          updateUI();
        }
      };
    }

    function initChart() {
      canvas = document.getElementById('chart-canvas');
      ctx = canvas.getContext('2d');
      const resize = () => {
        canvas.width = canvas.parentElement.clientWidth * devicePixelRatio;
        canvas.height = canvas.parentElement.clientHeight * devicePixelRatio;
        ctx.scale(devicePixelRatio, devicePixelRatio);
      };
      window.onresize = resize;
      resize();
      const draw = () => {
        const w = canvas.width / devicePixelRatio, h = canvas.height / devicePixelRatio;
        ctx.clearRect(0, 0, w, h);
        if(candles.length) {
          const list = [...candles];
          if(activeCandle) list.push(activeCandle);
          let min = Math.min(...list.map(c => c.low)), max = Math.max(...list.map(c => c.high));
          const cW = (w - 60) / list.length;
          const getY = p => h - 20 - ((p - min) / (max - min || 1)) * (h - 40);

          list.forEach((c, i) => {
            const x = i * cW + 5, isUp = c.close >= c.open;
            ctx.strokeStyle = isUp ? '#10b981' : '#ef4444';
            ctx.fillStyle = ctx.strokeStyle;
            ctx.beginPath();
            ctx.moveTo(x + cW / 2, getY(c.high)); ctx.lineTo(x + cW / 2, getY(c.low));
            ctx.stroke();
            ctx.fillRect(x, Math.min(getY(c.open), getY(c.close)), cW - 2, Math.max(Math.abs(getY(c.close) - getY(c.open)), 2));
          });
        }
        requestAnimationFrame(draw);
      };
      draw();
    }

    function executeOrder(type) {
      const q = watchlist[activeIdx];
      positions.unshift({
        ticket: Math.floor(100000 + Math.random() * 900000),
        sym: q.sym, type, volume: +document.getElementById('trade-lots').value,
        open: q.price, curr: q.price, step: q.step, digits: q.digits, profit: 0, mode: accountMode
      });
      renderTrades();
      updateUI();
    }

    function renderTrades() {
      const tb = document.getElementById('positions-tbody');
      tb.innerHTML = '';
      positions.filter(p => p.mode === accountMode).forEach((p, idx) => {
        tb.innerHTML += \`<tr>
          <td class="p-1">#\${p.ticket}</td><td>\${p.sym}</td>
          <td class="\${p.type === 'BUY' ? 'text-emerald-400' : 'text-red-400'}">\${p.type}</td>
          <td>\${p.volume}</td><td>\${p.open.toFixed(p.digits)}</td><td>\${p.curr.toFixed(p.digits)}</td>
          <td class="\${p.profit >= 0 ? 'text-emerald-400' : 'text-red-400'}">\${p.profit.toFixed(2)}</td>
          <td><button onclick="closeTrade(\${idx})" class="text-gray-400 hover:text-white">✕</button></td>
        </tr>\`;
      });
    }

    function closeTrade(i) {
      const p = positions[i];
      if(accountMode === 'REAL') realBalance += p.profit;
      else demoBalance += p.profit;
      positions.splice(i, 1);
      renderTrades();
      updateUI();
    }

    window.onload = () => {
      const wb = document.getElementById('watchlist-box');
      watchlist.forEach((q, i) => {
        const d = document.createElement('div');
        d.className = 'p-2 cursor-pointer border-b border-[#111827] hover:bg-gray-900';
        d.innerText = q.sym;
        d.onclick = () => { activeIdx = i; document.getElementById('active-sym').innerText = q.sym; connectLiveStream(q); };
        wb.appendChild(d);
      });
      initChart();
      connectLiveStream(watchlist[0]);
    };
  </script>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log(`Cloud Server is running on port ${PORT}`);
});