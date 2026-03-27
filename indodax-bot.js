/**
 * ============================================================
 *  MULTI-COIN BOT - INDODAX + CLAUDE AI + SENTIMENT ANALYSIS
 *  Data: Fear & Greed Index + CoinGecko + Indodax
 *  Otak: Claude AI → keputusan BUY / SELL / HOLD per koin
 *  Dashboard: http://localhost:3000
 * ============================================================
 *
 * SETUP:
 * 1. npm install axios crypto-js @anthropic-ai/sdk dotenv express
 * 2. Isi file .env:
 *      INDODAX_API_KEY=...
 *      INDODAX_SECRET_KEY=...
 *      ANTHROPIC_API_KEY=...
 * 3. node indodax-bot.js
 * 4. Buka http://localhost:3000
 */

require("dotenv").config();
const axios     = require("axios");
const crypto    = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const express   = require("express");
const path      = require("path");

// ============================================================
// ⚙️  KONFIGURASI
// ============================================================
const CONFIG = {
  API_KEY:    process.env.INDODAX_API_KEY    || "ISI_API_KEY_KAMU",
  SECRET_KEY: process.env.INDODAX_SECRET_KEY || "ISI_SECRET_KEY_KAMU",

  MAX_ORDER_IDR: 150000,      // Rp 150.000 per order (3 order × Rp150k + Rp50k fee = Rp500k)
  MAX_ORDERS: 3,              // Maksimal 3 order DCA per posisi
  CHECK_INTERVAL_MS: 15000,   // Cek harga setiap 15 detik
  CLAUDE_ANALYSIS_INTERVAL: 8, // Analisis Claude tiap ~2 menit (8 × 15 detik)

  DRY_RUN: false,             // true = simulasi | false = trading sungguhan
  DASHBOARD_PORT: 3000,
};

// ============================================================
// 🪙  DAFTAR KOIN  (tambah/hapus sesuai kebutuhan)
// ============================================================
const COINS = [
  { symbol: "doge", pair: "doge_idr", coingeckoId: "dogecoin", name: "DOGE", priceDecimals: 0 },
];

// ============================================================
const BASE_URL     = "https://indodax.com";
const claudeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── State per koin ──────────────────────────────────────────
const state = {};
for (const coin of COINS) {
  state[coin.symbol] = {
    buyPrice:       null,   // harga rata-rata tertimbang (weighted avg)
    coinHeld:       0,
    totalIdrSpent:  0,      // total IDR terpakai di posisi ini (untuk hitung avg)
    orderCount:     0,      // jumlah order DCA sudah masuk (0–3)
    referencePrice: null,
    priceHistory:   [],
    cycleCount:     0,
    strategy: {
      action:           "HOLD",
      BUY_DROP_PERCENT:  2,
      SELL_RISE_PERCENT: 3,
      STOP_LOSS_PERCENT: 2.5,
      sentiment:        "NEUTRAL",
      confidence:       0,
      reasoning:        "Menunggu analisis Claude AI...",
      lastUpdated:      null,
    },
  };
}

// ── Global data ──────────────────────────────────────────────
let fearGreedData  = null;
let coinGeckoData  = {};
let mainCycleCount = 0;
const tradeLog     = [];   // max 100 transaksi
const botStartTime = Date.now();

// ============================================================
// 📡  SSE DASHBOARD SERVER
// ============================================================
const app     = express();
const clients = new Set();

app.use(express.static(path.join(__dirname, "public")));

// SSE endpoint — dashboard connect ke sini
app.get("/events", (_req, res) => {
  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders();

  // Kirim state awal saat client connect
  const initData = {
    type:      "init",
    coins:     COINS.map(c => ({ ...c })),
    config:    { DRY_RUN: CONFIG.DRY_RUN, MAX_ORDER_IDR: CONFIG.MAX_ORDER_IDR },
    fearGreed: fearGreedData,
    tradeLog:  tradeLog.slice(-50),
    startTime: botStartTime,
    state: Object.fromEntries(COINS.map(c => {
      const s = state[c.symbol];
      return [c.symbol, {
        buyPrice:       s.buyPrice,
        coinHeld:       s.coinHeld,
        totalIdrSpent:  s.totalIdrSpent,
        orderCount:     s.orderCount,
        priceHistory:   s.priceHistory.slice(-20),
        strategy:       s.strategy,
        referencePrice: s.referencePrice,
      }];
    })),
  };
  res.write(`data: ${JSON.stringify(initData)}\n\n`);

  // Heartbeat setiap 30 detik supaya koneksi tidak putus
  const hb = setInterval(() => res.write(": ping\n\n"), 30000);

  clients.add(res);
  _req.on("close", () => { clients.delete(res); clearInterval(hb); });
});

// REST endpoint — bisa di-poll juga kalau SSE tidak tersedia
app.get("/api/state", (req, res) => {
  res.json({
    fearGreed: fearGreedData,
    tradeLog:  tradeLog.slice(-50),
    startTime: botStartTime,
    state: Object.fromEntries(COINS.map(c => {
      const s = state[c.symbol];
      return [c.symbol, {
        buyPrice:       s.buyPrice,
        coinHeld:       s.coinHeld,
        totalIdrSpent:  s.totalIdrSpent,
        orderCount:     s.orderCount,
        priceHistory:   s.priceHistory.slice(-20),
        strategy:       s.strategy,
        referencePrice: s.referencePrice,
      }];
    })),
  });
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.write(msg); } catch (_) { clients.delete(client); }
  }
}

// ============================================================
// 🛠️  UTILITIES
// ============================================================
function log(type, coinSymbol, msg) {
  const time  = new Date().toLocaleTimeString("id-ID");
  const icons = { INFO:"ℹ️ ", BUY:"🟢", SELL:"🔴", WARN:"⚠️ ", ERROR:"❌", PROFIT:"💰", AI:"🤖", STOP:"🛑" };
  const tag   = coinSymbol ? `[${coinSymbol.toUpperCase()}] ` : "";
  console.log(`[${time}] ${icons[type] || "•"} ${tag}${msg}`);
}

function fPrice(price, coin) {
  if (price === null || price === undefined) return "-";
  if (coin.priceDecimals === 0) return `Rp${Math.round(price).toLocaleString("id-ID")}`;
  return `Rp${price.toFixed(coin.priceDecimals)}`;
}

function fAmount(amount, coin) {
  return `${Math.floor(amount).toLocaleString("id-ID")} ${coin.name}`;
}

function createSignature(body, secret) {
  return crypto.createHmac("sha512", secret).update(body).digest("hex");
}

// ============================================================
// 📡  DATA EKSTERNAL
// ============================================================

// Fear & Greed Index — gratis, tanpa API key
async function fetchFearGreed() {
  try {
    const res = await axios.get("https://api.alternative.me/fng/?limit=1", { timeout: 5000 });
    const d   = res.data.data[0];
    return { value: parseInt(d.value), classification: d.value_classification };
  } catch (err) {
    log("WARN", null, `Fear & Greed gagal: ${err.message} — pakai cache`);
    return fearGreedData;
  }
}

// CoinGecko — batch semua koin sekaligus (hemat request)
async function fetchCoinGecko() {
  const ids = COINS.map(c => c.coingeckoId).join(",");
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/coins/markets", {
      params: {
        vs_currency: "idr",
        ids,
        order: "market_cap_desc",
        sparkline: false,
        price_change_percentage: "24h,7d",
      },
      timeout: 8000,
    });
    const result = {};
    for (const item of res.data) {
      const coin = COINS.find(c => c.coingeckoId === item.id);
      if (coin) {
        result[coin.symbol] = {
          change24h:  item.price_change_percentage_24h,
          change7d:   item.price_change_percentage_7d_in_currency,
          volume24h:  item.total_volume,
          marketCap:  item.market_cap,
          high24h:    item.high_24h,
          low24h:     item.low_24h,
        };
      }
    }
    return result;
  } catch (err) {
    log("WARN", null, `CoinGecko gagal: ${err.message} — pakai cache`);
    return coinGeckoData;
  }
}

// ============================================================
// 🏦  INDODAX API
// ============================================================
async function getCurrentPrice(coin) {
  try {
    const res    = await axios.get(`${BASE_URL}/api/${coin.pair}/ticker`, { timeout: 5000 });
    const t      = res.data.ticker;
    const volKey = `vol_${coin.symbol}`;
    return {
      last:     parseFloat(t.last),
      buy:      parseFloat(t.buy),
      sell:     parseFloat(t.sell),
      high:     parseFloat(t.high),
      low:      parseFloat(t.low),
      vol_coin: parseFloat(t[volKey] || 0),
      vol_idr:  parseFloat(t.vol_idr || 0),
    };
  } catch (err) {
    log("ERROR", coin.symbol, `Gagal ambil harga: ${err.message}`);
    return null;
  }
}

async function privateRequest(method, params = {}) {
  const nonce = Date.now().toString();
  const body  = new URLSearchParams({ method, nonce, ...params }).toString();
  const sign  = createSignature(body, CONFIG.SECRET_KEY);
  try {
    const res = await axios.post(`${BASE_URL}/tapi`, body, {
      headers: { "Key": CONFIG.API_KEY, "Sign": sign, "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10000,
    });
    if (res.data.success !== 1) throw new Error(res.data.error || "API error");
    return res.data.return;
  } catch (err) {
    log("ERROR", null, `API error (${method}): ${err.message}`);
    return null;
  }
}

async function getBalance(coin) {
  const info = await privateRequest("getInfo");
  if (!info) return null;
  return {
    idr:  parseFloat(info.balance.idr           || 0),
    coin: parseFloat(info.balance[coin.symbol]  || 0),
  };
}

// ============================================================
// 🤖  CLAUDE AI ANALYSIS
// ============================================================
async function analyzeWithClaude(coin, ticker) {
  const s = state[coin.symbol];
  if (s.priceHistory.length < 5) {
    log("AI", coin.symbol, "Menunggu data harga lebih banyak...");
    return false;
  }

  // Statistik harga Indodax
  const history  = s.priceHistory.slice(-10);
  const prices   = history.map(p => p.price);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const volat    = ((Math.max(...prices) - Math.min(...prices)) / avgPrice) * 100;
  const avgChg   = history.map(p => p.change).reduce((a, b) => a + b, 0) / history.length;
  const trend    = avgChg > 0.05 ? "NAIK" : avgChg < -0.05 ? "TURUN" : "SIDEWAYS";

  const recentData = history
    .map(p => `  ${new Date(p.timestamp).toLocaleTimeString("id-ID")}: ${fPrice(p.price, coin)} (${p.change >= 0 ? "+" : ""}${p.change.toFixed(3)}%)`)
    .join("\n");

  // Susun konteks Fear & Greed
  const fg = fearGreedData;
  const fgText = fg
    ? `${fg.value} — ${fg.classification}\n  Interpretasi: ${
        fg.value <= 24 ? "🟢 Extreme Fear = peluang beli kuat" :
        fg.value <= 49 ? "🟡 Fear = hati-hati, tapi ada peluang" :
        fg.value === 50 ? "⚪ Neutral" :
        fg.value <= 75 ? "🟠 Greed = mulai waspada" :
        "🔴 Extreme Greed = risiko koreksi tinggi"}`
    : "tidak tersedia";

  // Susun konteks CoinGecko
  const cg = coinGeckoData[coin.symbol];
  const cgText = cg
    ? `- Perubahan 24j: ${cg.change24h?.toFixed(2) ?? "N/A"}%
- Perubahan 7 hari: ${cg.change7d?.toFixed(2) ?? "N/A"}%
- Volume 24j: Rp${cg.volume24h?.toLocaleString("id-ID") ?? "N/A"}
- Market Cap: Rp${cg.marketCap?.toLocaleString("id-ID") ?? "N/A"}
- High/Low 24j: ${fPrice(cg.high24h, coin)} / ${fPrice(cg.low24h, coin)}`
    : "tidak tersedia";

  const posisi = s.buyPrice
    ? `Holding ${fAmount(s.coinHeld, coin)}, avg buy @ ${fPrice(s.buyPrice, coin)} | P/L: ${(((ticker.last - s.buyPrice) / s.buyPrice) * 100).toFixed(2)}% | DCA order: ${s.orderCount}/${CONFIG.MAX_ORDERS} (total dipakai: Rp${s.totalIdrSpent.toLocaleString("id-ID")})`
    : `Tidak holding ${coin.name} (siap order DCA 1/${CONFIG.MAX_ORDERS})`;

  const prompt = `Kamu adalah AI analis trading kripto untuk pasar ${coin.name}/IDR di Indodax Indonesia.

## 😱 Sentimen Pasar Global
Fear & Greed Index: ${fgText}

## 📊 Data CoinGecko (${coin.name} — global)
${cgText}

## 🏦 Data Indodax ${coin.name}/IDR (lokal)
- Harga terakhir: ${fPrice(ticker.last, coin)}
- Bid / Ask: ${fPrice(ticker.buy, coin)} / ${fPrice(ticker.sell, coin)}
- High / Low hari ini: ${fPrice(ticker.high, coin)} / ${fPrice(ticker.low, coin)}
- Volume 24j: ${ticker.vol_coin.toLocaleString("id-ID")} ${coin.name}

## 📈 Riwayat Harga (10 data, interval ~15 detik)
${recentData}

## 📉 Statistik
- Rata-rata: ${fPrice(avgPrice, coin)} | Volatilitas: ${volat.toFixed(2)}% | Tren: ${trend}

## 💼 Posisi Saat Ini
${posisi}

## Strategi Aktif (DCA — Dollar Cost Averaging)
- Beli drop: -${s.strategy.BUY_DROP_PERCENT}% | Target jual (dari avg): +${s.strategy.SELL_RISE_PERCENT}% | Stop loss: -${s.strategy.STOP_LOSS_PERCENT}%
- Modal per order: Rp${CONFIG.MAX_ORDER_IDR.toLocaleString("id-ID")} | Maks ${CONFIG.MAX_ORDERS} order DCA | Order sudah masuk: ${s.orderCount}

Berdasarkan semua data di atas (Fear & Greed, CoinGecko, harga Indodax, tren),
tentukan keputusan trading terbaik untuk ${coin.name}/IDR saat ini.

Jawab HANYA dalam format JSON berikut (tanpa teks lain):
{
  "action": "BUY" | "SELL" | "HOLD",
  "buy_drop_percent": <angka 0.5-5.0>,
  "sell_rise_percent": <angka 1.0-8.0>,
  "stop_loss_percent": <angka 0.5-5.0>,
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL" | "VOLATILE",
  "confidence": <angka 0-100>,
  "reasoning": "<penjelasan singkat bahasa Indonesia, max 80 kata>"
}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await claudeClient.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });

      const text      = response.content.find(b => b.type === "text")?.text?.trim() || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Format JSON tidak ditemukan");

      const a = JSON.parse(jsonMatch[0]);

      s.strategy = {
        action:           ["BUY", "SELL", "HOLD"].includes(a.action) ? a.action : "HOLD",
        BUY_DROP_PERCENT:  Math.max(0.5, Math.min(5.0, parseFloat(a.buy_drop_percent)  || s.strategy.BUY_DROP_PERCENT)),
        SELL_RISE_PERCENT: Math.max(1.0, Math.min(8.0, parseFloat(a.sell_rise_percent) || s.strategy.SELL_RISE_PERCENT)),
        STOP_LOSS_PERCENT: Math.max(0.5, Math.min(5.0, parseFloat(a.stop_loss_percent) || s.strategy.STOP_LOSS_PERCENT)),
        sentiment:        a.sentiment  || "NEUTRAL",
        confidence:       parseInt(a.confidence) || 50,
        reasoning:        a.reasoning  || "-",
        lastUpdated:      new Date().toLocaleTimeString("id-ID"),
      };

      const actionIcon = { BUY: "📈🟢 BUY", SELL: "📉🔴 SELL", HOLD: "⏸️  HOLD" }[s.strategy.action];
      log("AI", coin.symbol, `${actionIcon} | ${s.strategy.sentiment} | Conf: ${s.strategy.confidence}%`);
      log("AI", coin.symbol, `   Drop: -${s.strategy.BUY_DROP_PERCENT}% | Target: +${s.strategy.SELL_RISE_PERCENT}% | Stop: -${s.strategy.STOP_LOSS_PERCENT}%`);
      log("AI", coin.symbol, `   ${s.strategy.reasoning}`);

      // Broadcast ke dashboard
      broadcast({ type: "analysis", coin: coin.symbol, strategy: s.strategy });
      return true;

    } catch (err) {
      if (err instanceof Anthropic.InternalServerError && err.status === 529 && attempt < 3) {
        const wait = attempt * 10000;
        log("WARN", coin.symbol, `Claude overloaded, retry ${attempt}/3 dalam ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        log("WARN", coin.symbol, `Analisis Claude gagal: ${err.message}`);
        return false;
      }
    }
  }
  return false;
}

// ============================================================
// 💸  EKSEKUSI ORDER
// ============================================================
async function placeBuyOrder(coin, price) {
  const s       = state[coin.symbol];
  const balance = await getBalance(coin);
  if (!balance) return false;

  const idrToUse = Math.min(balance.idr * 0.95, CONFIG.MAX_ORDER_IDR);
  if (idrToUse < 10000) {
    log("WARN", coin.symbol, `Saldo IDR tidak cukup: Rp${balance.idr.toLocaleString("id-ID")}`);
    return false;
  }

  const amount      = Math.floor(idrToUse / price);
  const priceStr    = coin.priceDecimals > 0 ? price.toFixed(coin.priceDecimals) : Math.round(price).toString();
  const orderLabel  = `Order #${s.orderCount + 1}/${CONFIG.MAX_ORDERS}`;

  log("BUY", coin.symbol, `[${CONFIG.DRY_RUN ? "DRY" : "LIVE"}] ${orderLabel} BELI ${fAmount(amount, coin)} @ ${fPrice(price, coin)}`);

  // Hitung weighted average buy price
  function applyBuy(amt, idr) {
    const newTotal   = s.totalIdrSpent + idr;
    const newHeld    = s.coinHeld + amt;
    s.totalIdrSpent  = newTotal;
    s.coinHeld       = newHeld;
    s.buyPrice       = newTotal / newHeld;  // weighted avg
    s.orderCount++;
    log("INFO", coin.symbol,
      `Avg buy price: ${fPrice(s.buyPrice, coin)} | Total: Rp${s.totalIdrSpent.toLocaleString("id-ID")} | Order ${s.orderCount}/${CONFIG.MAX_ORDERS}`
    );
  }

  if (CONFIG.DRY_RUN) {
    applyBuy(amount, idrToUse);
    addTrade("BUY", coin, price, amount, idrToUse);
    return true;
  }

  const result = await privateRequest("trade", {
    pair:  coin.pair,
    type:  "buy",
    price: priceStr,
    idr:   Math.floor(idrToUse).toString(),
  });

  if (result) {
    applyBuy(amount, idrToUse);
    log("BUY", coin.symbol, `Order berhasil! ID: ${result.order_id}`);
    addTrade("BUY", coin, price, amount, idrToUse);
    return true;
  }
  return false;
}

async function placeSellOrder(coin, price, reason = "Target profit") {
  const s       = state[coin.symbol];
  const balance = await getBalance(coin);
  if (!balance) return false;

  const amount    = CONFIG.DRY_RUN ? s.coinHeld : Math.floor(balance.coin);
  const minAmount = Math.max(1, Math.ceil(10000 / price)); // minimum Rp10.000
  if (amount < minAmount) {
    log("WARN", coin.symbol, `Saldo ${coin.name} tidak cukup: ${fAmount(amount, coin)}`);
    return false;
  }

  const priceStr = coin.priceDecimals > 0 ? price.toFixed(coin.priceDecimals) : Math.round(price).toString();
  const type     = reason.includes("Stop loss") ? "STOP" : "SELL";

  log(type, coin.symbol, `[${CONFIG.DRY_RUN ? "DRY" : "LIVE"}] ${reason} — JUAL ${fAmount(amount, coin)} @ ${fPrice(price, coin)}`);

  // Hitung profit vs weighted avg buy price
  const profit    = s.buyPrice ? (price - s.buyPrice) * amount : null;
  const profitPct = s.buyPrice ? ((price - s.buyPrice) / s.buyPrice) * 100 : null;

  function resetPosition() {
    s.coinHeld      = 0;
    s.buyPrice      = null;
    s.totalIdrSpent = 0;
    s.orderCount    = 0;
  }

  if (CONFIG.DRY_RUN) {
    log("PROFIT", coin.symbol, `${profit >= 0 ? "Profit" : "Loss"}: Rp${Math.round(profit).toLocaleString("id-ID")} (${profitPct.toFixed(2)}%) | ${s.orderCount} order DCA`);
    addTrade(type, coin, price, amount, price * amount, profit, profitPct, reason);
    resetPosition();
    return true;
  }

  const result = await privateRequest("trade", {
    pair:            coin.pair,
    type:            "sell",
    price:           priceStr,
    [coin.symbol]:   amount.toString(),
  });

  if (result) {
    addTrade(type, coin, price, amount, price * amount, profit, profitPct, reason);
    resetPosition();
    log("SELL", coin.symbol, `Order berhasil! ID: ${result.order_id}`);
    return true;
  }
  return false;
}

function addTrade(type, coin, price, amount, idrValue, profit = null, profitPct = null, reason = "") {
  const entry = {
    time:      new Date().toLocaleString("id-ID"),
    timestamp: Date.now(),
    type,
    coin:      coin.symbol,
    name:      coin.name,
    price,
    amount,
    idrValue,
    profit,
    profitPct,
    reason,
  };
  tradeLog.push(entry);
  if (tradeLog.length > 100) tradeLog.shift();
  broadcast({ type: "trade", entry });
}

// ============================================================
// 🔁  LOGIKA TRADING PER KOIN
// ============================================================
function updatePriceHistory(coin, price) {
  const s    = state[coin.symbol];
  const prev = s.priceHistory[s.priceHistory.length - 1];
  const chg  = prev ? ((price - prev.price) / prev.price) * 100 : 0;
  s.priceHistory.push({ timestamp: Date.now(), price, change: chg });
  if (s.priceHistory.length > 30) s.priceHistory.shift();
}

async function runCoin(coin) {
  const s = state[coin.symbol];
  s.cycleCount++;

  const ticker = await getCurrentPrice(coin);
  if (!ticker) return;

  const currentPrice = ticker.last;
  updatePriceHistory(coin, currentPrice);

  if (!s.referencePrice) {
    s.referencePrice = currentPrice;
    log("INFO", coin.symbol, `Harga referensi awal: ${fPrice(currentPrice, coin)}`);
  }

  // Analisis Claude setiap N cycle
  if (s.cycleCount % CONFIG.CLAUDE_ANALYSIS_INTERVAL === 1) {
    await analyzeWithClaude(coin, ticker);
  }

  const strat           = s.strategy;
  const isHolding       = s.buyPrice !== null;
  const canDCA          = isHolding && s.orderCount < CONFIG.MAX_ORDERS;

  // Trigger harga
  const buyTrigger      = s.referencePrice * (1 - strat.BUY_DROP_PERCENT  / 100);
  const avgDownTrigger  = isHolding ? s.buyPrice * (1 - strat.BUY_DROP_PERCENT / 100) : null;
  const sellTrigger     = isHolding ? s.buyPrice * (1 + strat.SELL_RISE_PERCENT / 100) : null;
  const stopLossTrigger = isHolding ? s.buyPrice * (1 - strat.STOP_LOSS_PERCENT / 100) : null;
  const tag             = strat.lastUpdated ? `[${strat.action}/${strat.sentiment}]` : "[DEFAULT]";

  // P/L kalkulasi
  const plPct = isHolding ? ((currentPrice - s.buyPrice) / s.buyPrice) * 100 : null;
  const plIdr = isHolding ? (currentPrice - s.buyPrice) * s.coinHeld : null;

  // Broadcast update harga ke dashboard
  broadcast({
    type:            "price",
    coin:            coin.symbol,
    price:           currentPrice,
    ticker:          { buy: ticker.buy, sell: ticker.sell, high: ticker.high, low: ticker.low, vol_coin: ticker.vol_coin },
    priceHistory:    s.priceHistory.slice(-20),
    isHolding,
    buyPrice:        s.buyPrice,
    coinHeld:        s.coinHeld,
    totalIdrSpent:   s.totalIdrSpent,
    orderCount:      s.orderCount,
    maxOrders:       CONFIG.MAX_ORDERS,
    referencePrice:  s.referencePrice,
    buyTrigger,
    avgDownTrigger,
    sellTrigger,
    stopLossTrigger,
    plPct,
    plIdr,
  });

  // Status log
  if (isHolding) {
    log("INFO", coin.symbol,
      `${fPrice(currentPrice, coin)} ${tag} | DCA ${s.orderCount}/${CONFIG.MAX_ORDERS} | Avg: ${fPrice(s.buyPrice, coin)} | P/L: ${plPct.toFixed(2)}% | Target: ${fPrice(sellTrigger, coin)}`
    );
  } else {
    log("INFO", coin.symbol,
      `${fPrice(currentPrice, coin)} ${tag} | Idle | Trigger beli: ${fPrice(buyTrigger, coin)} (-${strat.BUY_DROP_PERCENT}%)`
    );
  }

  // ── 1. STOP LOSS (jual semua posisi) ──────────────────────
  if (isHolding && stopLossTrigger && currentPrice <= stopLossTrigger) {
    log("STOP", coin.symbol, `Stop loss! ${fPrice(currentPrice, coin)} ≤ ${fPrice(stopLossTrigger, coin)} | ${s.orderCount} order DCA dilikuidasi`);
    const ok = await placeSellOrder(coin, currentPrice, `Stop loss -${strat.STOP_LOSS_PERCENT}%`);
    if (ok) { s.referencePrice = currentPrice; s.cycleCount = 0; }
    return;
  }

  // ── 2. CLAUDE BILANG JUAL ─────────────────────────────────
  if (isHolding && strat.action === "SELL" && strat.confidence >= 60) {
    log("SELL", coin.symbol, `Claude SELL (conf: ${strat.confidence}%) | ${s.orderCount} order DCA akan dijual`);
    const ok = await placeSellOrder(coin, currentPrice, `Claude SELL signal`);
    if (ok) s.referencePrice = currentPrice;
    return;
  }

  // ── 3. TARGET PROFIT DARI AVG BUY PRICE ───────────────────
  if (isHolding && sellTrigger && currentPrice >= sellTrigger) {
    log("SELL", coin.symbol, `Target +${strat.SELL_RISE_PERCENT}% dari avg tercapai! Jual ${s.orderCount} order DCA`);
    const ok = await placeSellOrder(coin, currentPrice, `Target +${strat.SELL_RISE_PERCENT}% (avg DCA)`);
    if (ok) s.referencePrice = currentPrice;
    return;
  }

  // ── 4. AVERAGE DOWN — harga turun lagi dari avg buy ───────
  if (canDCA && avgDownTrigger && currentPrice <= avgDownTrigger) {
    if (strat.sentiment === "BEARISH" && strat.confidence >= 80) {
      log("WARN", coin.symbol, `Average down skip — BEARISH ${strat.confidence}%`);
      return;
    }
    log("BUY", coin.symbol, `Average down! Harga turun ${strat.BUY_DROP_PERCENT}% dari avg. Order #${s.orderCount + 1}/${CONFIG.MAX_ORDERS}`);
    await placeBuyOrder(coin, currentPrice);
    return;
  }

  // ── 5. CLAUDE BUY SEKARANG (belum holding, confidence tinggi) ──
  if (!isHolding && strat.action === "BUY" && strat.confidence >= 75) {
    log("BUY", coin.symbol, `Claude rekomendasikan BUY sekarang (conf: ${strat.confidence}%) — DCA Order #1`);
    const ok = await placeBuyOrder(coin, currentPrice);
    if (ok) s.referencePrice = currentPrice;
    return;
  }

  // ── 6. TUNGGU HARGA TURUN KE TRIGGER (order pertama) ──────
  if (!isHolding && strat.action === "BUY" && currentPrice <= buyTrigger) {
    if (strat.sentiment === "BEARISH" && strat.confidence >= 80) {
      log("WARN", coin.symbol, `Sinyal beli ada tapi BEARISH ${strat.confidence}% — skip`);
      return;
    }
    log("BUY", coin.symbol, `Harga turun ${strat.BUY_DROP_PERCENT}% dari referensi — DCA Order #1`);
    const ok = await placeBuyOrder(coin, currentPrice);
    if (ok) s.referencePrice = currentPrice;
  }
}

// ============================================================
// 🚀  MAIN LOOP
// ============================================================
async function runAll() {
  mainCycleCount++;

  // Fetch Fear & Greed + CoinGecko setiap analysis interval
  if (mainCycleCount % CONFIG.CLAUDE_ANALYSIS_INTERVAL === 1) {
    log("INFO", null, "Mengambil Fear & Greed + CoinGecko...");
    [fearGreedData, coinGeckoData] = await Promise.all([
      fetchFearGreed(),
      fetchCoinGecko(),
    ]);
    if (fearGreedData) {
      const fgIcon =
        fearGreedData.value <= 24 ? "🟢" :
        fearGreedData.value <= 49 ? "🟡" :
        fearGreedData.value <= 75 ? "🟠" : "🔴";
      log("INFO", null, `${fgIcon} Fear & Greed: ${fearGreedData.value} — ${fearGreedData.classification}`);
      broadcast({ type: "feargreed", data: fearGreedData });
    }
  }

  // Jalankan setiap koin (berurutan untuk menghindari rate limit)
  for (const coin of COINS) {
    await runCoin(coin);
  }
}

async function main() {
  const coinList = COINS.map(c => c.name).join(", ");
  console.log("=".repeat(62));
  console.log(`  🤖 MULTI-COIN BOT — INDODAX + CLAUDE AI + SENTIMENT`);
  console.log(`  Koin   : ${coinList}`);
  console.log(`  Mode   : ${CONFIG.DRY_RUN ? "🔵 DRY RUN (Simulasi)" : "🔴 LIVE TRADING"}`);
  console.log(`  Budget : Rp${CONFIG.MAX_ORDER_IDR.toLocaleString("id-ID")} per koin per order`);
  console.log(`  Analisis Claude: ~${(CONFIG.CLAUDE_ANALYSIS_INTERVAL * CONFIG.CHECK_INTERVAL_MS) / 60000} menit sekali`);
  console.log("=".repeat(62));

  if (!process.env.ANTHROPIC_API_KEY) {
    log("WARN", null, "ANTHROPIC_API_KEY belum di-set di .env!");
  }

  if (CONFIG.API_KEY !== "ISI_API_KEY_KAMU") {
    const info = await privateRequest("getInfo");
    if (info) {
      const idr      = parseFloat(info.balance.idr || 0);
      const coinBals = COINS.map(c => `${c.name}: ${Math.floor(info.balance[c.symbol] || 0).toLocaleString("id-ID")}`).join(" | ");
      log("INFO", null, `Saldo IDR : Rp${idr.toLocaleString("id-ID")}`);
      log("INFO", null, `Saldo koin: ${coinBals}`);
    }
  }

  // Start dashboard server
  app.listen(CONFIG.DASHBOARD_PORT, () => {
    log("INFO", null, `Dashboard: http://localhost:${CONFIG.DASHBOARD_PORT}`);
  });

  log("INFO", null, `${COINS.length} koin aktif, cek setiap ${CONFIG.CHECK_INTERVAL_MS / 1000} detik`);
  log("INFO", null, "Tekan Ctrl+C untuk hentikan");
  console.log("-".repeat(62));

  await runAll();
  setInterval(runAll, CONFIG.CHECK_INTERVAL_MS);
}

main().catch(err => {
  log("ERROR", null, `Fatal: ${err.message}`);
  process.exit(1);
});
