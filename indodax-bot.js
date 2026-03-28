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
const fs        = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
const express   = require("express");
const path      = require("path");

// ============================================================
// ⚙️  KONFIGURASI
// ============================================================
const CONFIG = {
  API_KEY:    process.env.INDODAX_API_KEY    || "ISI_API_KEY_KAMU",
  SECRET_KEY: process.env.INDODAX_SECRET_KEY || "ISI_SECRET_KEY_KAMU",
  CMC_API_KEY: process.env.CMC_API_KEY       || "ISI_CMC_API_KEY",

  TOTAL_MODAL_IDR:      744000,  // Rp744.000 total modal
  RESERVE_IDR:           84000,  // Rp84.000 cadangan fee ~11% — tidak boleh dipakai trading
  MAX_ORDER_IDR:        150000,  // Rp150.000 per order DCA
  // MAX_ORDERS ditentukan dinamis oleh Claude AI

  TRAILING_ACTIVATE_PCT:   1.0,  // trailing stop aktif setelah profit ≥ 1% dari avg buy
  TRAILING_STOP_PCT:       1.5,  // trailing stop: 1.5% di bawah harga tertinggi sejak entry

  COOLDOWN_MS:          300000,  // cooldown 5 menit setelah stop loss

  CHECK_INTERVAL_MS:     15000,  // Cek harga setiap 15 detik
  CLAUDE_ANALYSIS_INTERVAL: 8,   // Analisis Claude tiap ~2 menit (8 × 15 detik)

  DRY_RUN: false,                // true = simulasi | false = trading sungguhan
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
    buyPrice:          null,   // harga rata-rata tertimbang (weighted avg)
    coinHeld:          0,
    totalIdrSpent:     0,      // total IDR terpakai di posisi ini
    orderCount:        0,      // jumlah order DCA sudah masuk
    highestPrice:      null,   // harga tertinggi sejak entry (untuk trailing stop)
    trailingStopPrice: null,   // trailing stop aktif setelah profit ≥ TRAILING_ACTIVATE_PCT
    cooldownUntil:     null,   // timestamp akhir cooldown setelah stop loss
    referencePrice:    null,
    priceHistory:      [],
    cycleCount:        0,
    strategy: {
      action:           "HOLD",
      BUY_DROP_PERCENT:  2,
      SELL_RISE_PERCENT: 3,
      STOP_LOSS_PERCENT: 2.5,
      maxOrders:         4,   // ditentukan Claude, hard cap = floor((TOTAL-RESERVE)/PER_ORDER)
      sentiment:        "NEUTRAL",
      confidence:       0,
      reasoning:        "Menunggu analisis Claude AI...",
      lastUpdated:      null,
    },
  };
}

// ============================================================
// 💾  COOLDOWN PERSISTENCE (Bug #2)
// ============================================================
const COOLDOWN_FILE = path.join(__dirname, "cooldown.json");
const TRADES_FILE   = path.join(__dirname, "trades.json");
const STATS_FILE    = path.join(__dirname, "stats.json");

// Simpan cooldown ke file agar tetap ada setelah restart
function saveCooldown(symbol, until) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf8")); } catch (_) {}
  data[symbol] = until;
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data, null, 2));
}

// Baca cooldown dari file; return null kalau tidak ada atau sudah expired
function loadCooldown(symbol) {
  try {
    const data = JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf8"));
    const until = data[symbol];
    if (until && Date.now() < until) return until;
    // Hapus key expired dari file agar tidak kotor
    if (until) {
      delete data[symbol];
      fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data, null, 2));
    }
  } catch (_) {}
  return null;
}

// ============================================================
// 💾  TRADES & STATS PERSISTENCE
// ============================================================
function loadTrades() {
  try {
    const data = JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

function saveTrade(entry) {
  try {
    let trades = loadTrades();
    trades.push(entry);
    if (trades.length > 500) trades = trades.slice(-500);
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  } catch (e) {
    log("WARN", null, `Gagal simpan trade ke file: ${e.message}`);
  }
}

function loadStats() {
  try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    return (typeof data === "object" && data !== null) ? data : {};
  } catch (_) { return {}; }
}

function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {
    log("WARN", null, `Gagal simpan stats ke file: ${e.message}`);
  }
}

function updateStats(coinSymbol, profit) {
  const stats = loadStats();
  if (!stats[coinSymbol]) {
    stats[coinSymbol] = {
      totalTrades: 0, winTrades: 0, lossTrades: 0,
      totalProfit: 0, totalLoss: 0, winRate: 0,
      avgProfit: 0, avgLoss: 0, bestTrade: 0, worstTrade: 0, lastUpdated: "",
    };
  }
  const s = stats[coinSymbol];
  s.totalTrades++;
  if (profit > 0) {
    s.winTrades++;
    s.totalProfit += profit;
    if (profit > s.bestTrade) s.bestTrade = profit;
  } else if (profit < 0) {
    s.lossTrades++;
    s.totalLoss += profit;
    if (profit < s.worstTrade) s.worstTrade = profit;
  }
  s.winRate   = s.totalTrades > 0 ? (s.winTrades / s.totalTrades) * 100 : 0;
  s.avgProfit = s.winTrades > 0 ? s.totalProfit / s.winTrades : 0;
  s.avgLoss   = s.lossTrades > 0 ? s.totalLoss / s.lossTrades : 0;
  s.lastUpdated = new Date().toLocaleString("id-ID");
  saveStats(stats);
  broadcast({ type: "stats", stats });
}

// ── Log buffer (dikirim ke dashboard) ────────────────────────
const logBuffer = [];  // max 200 entri

// ── Global data ──────────────────────────────────────────────
let fearGreedData  = null;
let coinGeckoData  = {};
let cmcData        = null;
let balanceData    = null;
let mainCycleCount = 0;
const tradeLog     = [];   // max 500 transaksi (dimuat dari file saat start)
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
    fearGreed:   fearGreedData,
    tradeLog:    tradeLog.slice(-50),
    logBuffer:   logBuffer.slice(-100),
    stats:       loadStats(),
    balance:     balanceData,
    marketIntel: cmcData ? { cmc: cmcData } : null,
    startTime:   botStartTime,
    state: Object.fromEntries(COINS.map(c => {
      const s = state[c.symbol];
      return [c.symbol, {
        buyPrice:          s.buyPrice,
        coinHeld:          s.coinHeld,
        totalIdrSpent:     s.totalIdrSpent,
        orderCount:        s.orderCount,
        trailingStopPrice: s.trailingStopPrice,
        cooldownUntil:     s.cooldownUntil,
        priceHistory:      s.priceHistory.slice(-20),
        strategy:          s.strategy,
        referencePrice:    s.referencePrice,
        indicators:        calcIndicators(s.priceHistory),
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
        buyPrice:          s.buyPrice,
        coinHeld:          s.coinHeld,
        totalIdrSpent:     s.totalIdrSpent,
        orderCount:        s.orderCount,
        trailingStopPrice: s.trailingStopPrice,
        cooldownUntil:     s.cooldownUntil,
        priceHistory:      s.priceHistory.slice(-20),
        strategy:          s.strategy,
        referencePrice:    s.referencePrice,
      }];
    })),
  });
});

app.get("/api/stats", (_req, res) => {
  res.json(loadStats());
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
  const icon  = icons[type] || "•";
  const tag   = coinSymbol ? `[${coinSymbol.toUpperCase()}] ` : "";
  console.log(`[${time}] ${icon} ${tag}${msg}`);

  const entry = { time, type, coin: coinSymbol || null, msg };
  logBuffer.push(entry);
  if (logBuffer.length > 200) logBuffer.shift();
  broadcast({ type: "botlog", entry });
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

// CoinMarketCap — data DOGE + global market
async function fetchCoinMarketCap() {
  if (CONFIG.CMC_API_KEY === "ISI_CMC_API_KEY") return cmcData;
  try {
    const headers = { "X-CMC_PRO_API_KEY": CONFIG.CMC_API_KEY };
    const [quoteRes, globalRes] = await Promise.all([
      axios.get("https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest", {
        params: { symbol: COINS.map(c => c.name).join(","), convert: "USD" },
        headers,
        timeout: 8000,
      }),
      axios.get("https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest", {
        headers,
        timeout: 8000,
      }),
    ]);

    const result = { coins: {}, global: null };

    for (const coin of COINS) {
      const d = quoteRes.data.data[coin.name.toUpperCase()];
      if (d) {
        const q = d.quote.USD;
        result.coins[coin.symbol] = {
          rank:      d.cmc_rank,
          change1h:  q.percent_change_1h,
          change24h: q.percent_change_24h,
          change7d:  q.percent_change_7d,
          change30d: q.percent_change_30d,
          volume24h: q.volume_24h,
          marketCap: q.market_cap,
          volumeChange24h: q.volume_change_24h,
        };
      }
    }

    const g = globalRes.data.data;
    const gq = g.quote.USD;
    result.global = {
      btcDominance:      g.btc_dominance,
      ethDominance:      g.eth_dominance,
      totalMarketCap:    gq.total_market_cap,
      totalVolume24h:    gq.total_volume_24h,
      marketCapChange24h: gq.total_market_cap_yesterday_percentage_change,
      defiVolume24h:     gq.defi_volume_24h,
      defiMarketCap:     gq.defi_market_cap,
    };

    return result;
  } catch (err) {
    log("WARN", null, `CoinMarketCap gagal: ${err.message} — pakai cache`);
    return cmcData;
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

  // Susun konteks CoinMarketCap
  const cmc     = cmcData?.coins?.[coin.symbol];
  const cmcGlob = cmcData?.global;
  const cmcText = cmc
    ? `- CMC Rank: #${cmc.rank}
- Perubahan 1j: ${cmc.change1h?.toFixed(2) ?? "N/A"}%
- Perubahan 24j: ${cmc.change24h?.toFixed(2) ?? "N/A"}%
- Perubahan 7 hari: ${cmc.change7d?.toFixed(2) ?? "N/A"}%
- Perubahan 30 hari: ${cmc.change30d?.toFixed(2) ?? "N/A"}%
- Volume 24j (USD): $${cmc.volume24h?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "N/A"}
- Perubahan volume 24j: ${cmc.volumeChange24h?.toFixed(2) ?? "N/A"}%
- Market Cap (USD): $${cmc.marketCap?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "N/A"}`
    : "tidak tersedia";
  const cmcGlobText = cmcGlob
    ? `- Dominasi BTC: ${cmcGlob.btcDominance?.toFixed(2) ?? "N/A"}%
- Dominasi ETH: ${cmcGlob.ethDominance?.toFixed(2) ?? "N/A"}%
- Total Market Cap: $${cmcGlob.totalMarketCap?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "N/A"}
- Volume Global 24j: $${cmcGlob.totalVolume24h?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "N/A"}
- Perubahan Market Cap 24j: ${cmcGlob.marketCapChange24h?.toFixed(2) ?? "N/A"}%`
    : "tidak tersedia";

  const cooldownRemainSec = s.cooldownUntil ? Math.max(0, Math.ceil((s.cooldownUntil - Date.now()) / 1000)) : 0;
  const inCooldown        = cooldownRemainSec > 0;

  const trailingInfo = s.trailingStopPrice
    ? `Trailing stop AKTIF @ ${fPrice(s.trailingStopPrice, coin)} (highest: ${fPrice(s.highestPrice, coin)})`
    : `Trailing stop belum aktif (aktif setelah profit ≥ ${CONFIG.TRAILING_ACTIVATE_PCT}%)`;

  const posisi = s.buyPrice
    ? `Holding ${fAmount(s.coinHeld, coin)}, avg buy @ ${fPrice(s.buyPrice, coin)} | P/L: ${(((ticker.last - s.buyPrice) / s.buyPrice) * 100).toFixed(2)}% | DCA ${s.orderCount}/${s.strategy.maxOrders} order (Rp${s.totalIdrSpent.toLocaleString("id-ID")} terpakai)\n  ${trailingInfo}`
    : `Tidak holding — ${inCooldown ? `⏳ COOLDOWN ${cooldownRemainSec} detik lagi setelah stop loss` : `siap DCA order 1/${s.strategy.maxOrders}`}`;

  const prompt = `Kamu adalah AI analis trading kripto untuk pasar ${coin.name}/IDR di Indodax Indonesia.

## 😱 Sentimen Pasar Global
Fear & Greed Index: ${fgText}

## 📊 Data CoinGecko (${coin.name} — global)
${cgText}

## 📈 Data CoinMarketCap (${coin.name})
${cmcText}

## 🌍 Pasar Crypto Global (CMC)
${cmcGlobText}

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

## Strategi Aktif (DCA + Trailing Stop)
- DCA beli drop: -${s.strategy.BUY_DROP_PERCENT}% dari avg | Target jual: +${s.strategy.SELL_RISE_PERCENT}% dari avg | Fixed stop loss: -${s.strategy.STOP_LOSS_PERCENT}%
- Trailing stop: aktif setelah profit ≥ ${CONFIG.TRAILING_ACTIVATE_PCT}%, trail ${CONFIG.TRAILING_STOP_PCT}% di bawah highest price
- Cooldown: ${CONFIG.COOLDOWN_MS / 60000} menit setelah stop loss${inCooldown ? ` (AKTIF, sisa ${cooldownRemainSec} detik)` : " (tidak aktif)"}
- Modal: Rp${CONFIG.TOTAL_MODAL_IDR.toLocaleString("id-ID")} total | Rp${CONFIG.RESERVE_IDR.toLocaleString("id-ID")} fee (keep) | Rp${CONFIG.MAX_ORDER_IDR.toLocaleString("id-ID")}/order | Hard cap: ${Math.floor((CONFIG.TOTAL_MODAL_IDR - CONFIG.RESERVE_IDR) / CONFIG.MAX_ORDER_IDR)} order | AI pilih: ${s.strategy.maxOrders} order

Berdasarkan semua data di atas (Fear & Greed, CoinGecko, CoinMarketCap, dominasi pasar global, harga Indodax, tren),
tentukan keputusan trading terbaik untuk ${coin.name}/IDR saat ini.

Jawab HANYA dalam format JSON berikut (tanpa teks lain):
{
  "action": "BUY" | "SELL" | "HOLD",
  "buy_drop_percent": <angka 0.5-5.0>,
  "sell_rise_percent": <angka 1.0-8.0>,
  "stop_loss_percent": <angka 0.5-5.0>,
  "max_orders": <angka 1-${Math.floor((CONFIG.TOTAL_MODAL_IDR - CONFIG.RESERVE_IDR) / CONFIG.MAX_ORDER_IDR)}, berapa order DCA yang aman dipakai sesuai kondisi pasar>,
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

      const hardCap = Math.floor((CONFIG.TOTAL_MODAL_IDR - CONFIG.RESERVE_IDR) / CONFIG.MAX_ORDER_IDR);
      s.strategy = {
        action:           ["BUY", "SELL", "HOLD"].includes(a.action) ? a.action : "HOLD",
        BUY_DROP_PERCENT:  Math.max(0.5, Math.min(5.0, parseFloat(a.buy_drop_percent)  || s.strategy.BUY_DROP_PERCENT)),
        SELL_RISE_PERCENT: Math.max(1.0, Math.min(8.0, parseFloat(a.sell_rise_percent) || s.strategy.SELL_RISE_PERCENT)),
        STOP_LOSS_PERCENT: Math.max(0.5, Math.min(5.0, parseFloat(a.stop_loss_percent) || s.strategy.STOP_LOSS_PERCENT)),
        maxOrders:         Math.max(1, Math.min(hardCap, parseInt(a.max_orders) || s.strategy.maxOrders)),
        sentiment:        a.sentiment  || "NEUTRAL",
        confidence:       parseInt(a.confidence) || 50,
        reasoning:        a.reasoning  || "-",
        lastUpdated:      new Date().toLocaleTimeString("id-ID"),
      };

      const actionIcon = { BUY: "📈🟢 BUY", SELL: "📉🔴 SELL", HOLD: "⏸️  HOLD" }[s.strategy.action];
      log("AI", coin.symbol, `${actionIcon} | ${s.strategy.sentiment} | Conf: ${s.strategy.confidence}%`);
      log("AI", coin.symbol, `   Drop: -${s.strategy.BUY_DROP_PERCENT}% | Target: +${s.strategy.SELL_RISE_PERCENT}% | Stop: -${s.strategy.STOP_LOSS_PERCENT}% | Max DCA: ${s.strategy.maxOrders}`);
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

  const available = balance.idr - CONFIG.RESERVE_IDR;
  if (available <= 0 || available < 10000) {
    log("WARN", coin.symbol, `Saldo tidak cukup setelah reserve — Saldo: Rp${balance.idr.toLocaleString("id-ID")} | Reserve: Rp${CONFIG.RESERVE_IDR.toLocaleString("id-ID")} | Tersedia: Rp${Math.max(0, available).toLocaleString("id-ID")}`);
    return false;
  }
  const idrToUse = Math.min(available * 0.99, CONFIG.MAX_ORDER_IDR);
  log("INFO", coin.symbol, `Saldo: Rp${balance.idr.toLocaleString("id-ID")} | Reserve: Rp${CONFIG.RESERVE_IDR.toLocaleString("id-ID")} | Tersedia: Rp${available.toLocaleString("id-ID")} | Order: Rp${Math.round(idrToUse).toLocaleString("id-ID")}`);

  const amount      = Math.floor(idrToUse / price);
  const priceStr    = coin.priceDecimals > 0 ? price.toFixed(coin.priceDecimals) : Math.round(price).toString();
  const orderLabel  = `Order #${s.orderCount + 1}/${s.strategy.maxOrders}`;

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
      `Avg buy price: ${fPrice(s.buyPrice, coin)} | Total: Rp${s.totalIdrSpent.toLocaleString("id-ID")} | Order ${s.orderCount}/${s.strategy.maxOrders}`
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
    s.coinHeld          = 0;
    s.buyPrice          = null;
    s.totalIdrSpent     = 0;
    s.orderCount        = 0;
    s.highestPrice      = null;
    s.trailingStopPrice = null;
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
  if (tradeLog.length > 500) tradeLog.shift();
  saveTrade(entry);
  if ((type === "SELL" || type === "STOP") && profit !== null) {
    updateStats(coin.symbol, profit);
  }
  broadcast({ type: "trade", entry });
}

// ============================================================
// 📊  INDIKATOR TEKNIKAL
// ============================================================
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

function calcBB(prices, period = 20) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const sma   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period);
  return { upper: sma + 2 * std, middle: sma, lower: sma - 2 * std };
}

function calcIndicators(priceHistory) {
  const prices = priceHistory.map(p => p.price);
  if (prices.length < 5) return null;

  const rsi    = calcRSI(prices, 14);
  const ema9   = calcEMA(prices, 9);
  const ema21  = calcEMA(prices, 21);
  const bb     = calcBB(prices, 20);
  const ema12  = calcEMA(prices, 12);
  const ema26  = calcEMA(prices, 26);
  const macd   = (ema12 && ema26) ? parseFloat((ema12 - ema26).toFixed(4)) : null;
  const last   = prices[prices.length - 1];

  const rsiSignal = rsi === null ? "–" : rsi >= 70 ? "OVERBOUGHT" : rsi <= 30 ? "OVERSOLD" : "NORMAL";
  const emaSignal = (ema9 && ema21) ? (ema9 > ema21 ? "BULLISH" : "BEARISH") : "–";
  const bbPos     = bb ? parseFloat(((last - bb.lower) / (bb.upper - bb.lower) * 100).toFixed(1)) : null;
  const bbSignal  = bbPos === null ? "–" : bbPos >= 80 ? "UPPER" : bbPos <= 20 ? "LOWER" : "MIDDLE";
  const macdSignal = macd === null ? "–" : macd > 0 ? "BULLISH" : "BEARISH";

  // Sinyal keseluruhan
  let bull = 0, bear = 0;
  if (rsiSignal === "OVERSOLD")   bull++;
  if (rsiSignal === "OVERBOUGHT") bear++;
  if (emaSignal === "BULLISH")    bull++;
  if (emaSignal === "BEARISH")    bear++;
  if (macdSignal === "BULLISH")   bull++;
  if (macdSignal === "BEARISH")   bear++;
  const overall = bull >= 2 ? "BULLISH" : bear >= 2 ? "BEARISH" : "NEUTRAL";

  return {
    rsi, rsiSignal,
    ema9:  ema9  ? parseFloat(ema9.toFixed(2))  : null,
    ema21: ema21 ? parseFloat(ema21.toFixed(2)) : null,
    emaSignal,
    bb:    bb ? { upper: parseFloat(bb.upper.toFixed(2)), middle: parseFloat(bb.middle.toFixed(2)), lower: parseFloat(bb.lower.toFixed(2)) } : null,
    bbPos, bbSignal,
    macd, macdSignal,
    overall,
  };
}

// ============================================================
// 🔁  LOGIKA TRADING PER KOIN
// ============================================================
function updatePriceHistory(coin, price) {
  const s    = state[coin.symbol];
  const prev = s.priceHistory[s.priceHistory.length - 1];
  const chg  = prev ? ((price - prev.price) / prev.price) * 100 : 0;
  s.priceHistory.push({ timestamp: Date.now(), price, change: chg });
  if (s.priceHistory.length > 100) s.priceHistory.shift();
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

  const strat          = s.strategy;
  const isHolding      = s.buyPrice !== null;
  const modalTerpakai  = s.totalIdrSpent;
  const modalTersisa   = CONFIG.TOTAL_MODAL_IDR - CONFIG.RESERVE_IDR - modalTerpakai;
  const canDCA         = isHolding
                         && s.orderCount < strat.maxOrders
                         && modalTersisa >= CONFIG.MAX_ORDER_IDR * 0.5;

  // Log sekali per 10 cycle kalau modal tidak cukup untuk DCA berikutnya
  if (isHolding && s.orderCount < strat.maxOrders && modalTersisa < CONFIG.MAX_ORDER_IDR * 0.5) {
    if (s.cycleCount % 10 === 0) {
      log("WARN", coin.symbol, `Modal tidak cukup untuk DCA — tersisa: Rp${Math.round(modalTersisa).toLocaleString("id-ID")}`);
    }
  }
  const inCooldown  = s.cooldownUntil && Date.now() < s.cooldownUntil;
  const cooldownSec = inCooldown ? Math.ceil((s.cooldownUntil - Date.now()) / 1000) : 0;

  // ── Update trailing stop saat holding ─────────────────────
  if (isHolding) {
    // Lacak harga tertinggi sejak entry
    if (!s.highestPrice || currentPrice > s.highestPrice) {
      s.highestPrice = currentPrice;
    }
    // Aktifkan/perbarui trailing stop setelah profit ≥ threshold
    const plFromAvg = ((s.highestPrice - s.buyPrice) / s.buyPrice) * 100;
    if (plFromAvg >= CONFIG.TRAILING_ACTIVATE_PCT) {
      const newTrail = s.highestPrice * (1 - CONFIG.TRAILING_STOP_PCT / 100);
      // Trailing stop hanya boleh naik, tidak turun
      if (!s.trailingStopPrice || newTrail > s.trailingStopPrice) {
        s.trailingStopPrice = newTrail;
      }
    }
  }

  // Trigger harga
  const buyTrigger      = s.referencePrice * (1 - strat.BUY_DROP_PERCENT / 100);
  const avgDownTrigger  = isHolding ? s.buyPrice * (1 - strat.BUY_DROP_PERCENT / 100) : null;
  const sellTrigger     = isHolding ? s.buyPrice * (1 + strat.SELL_RISE_PERCENT / 100) : null;
  const stopLossTrigger = isHolding ? s.buyPrice * (1 - strat.STOP_LOSS_PERCENT / 100) : null;
  const tag             = strat.lastUpdated ? `[${strat.action}/${strat.sentiment}]` : "[DEFAULT]";

  // P/L kalkulasi
  const plPct = isHolding ? ((currentPrice - s.buyPrice) / s.buyPrice) * 100 : null;
  const plIdr = isHolding ? (currentPrice - s.buyPrice) * s.coinHeld : null;

  // Hitung indikator teknikal
  const indicators = calcIndicators(s.priceHistory);

  // Broadcast update harga ke dashboard
  broadcast({
    type:              "price",
    coin:              coin.symbol,
    price:             currentPrice,
    ticker:            { buy: ticker.buy, sell: ticker.sell, high: ticker.high, low: ticker.low, vol_coin: ticker.vol_coin },
    priceHistory:      s.priceHistory.slice(-20),
    isHolding,
    buyPrice:          s.buyPrice,
    coinHeld:          s.coinHeld,
    totalIdrSpent:     s.totalIdrSpent,
    orderCount:        s.orderCount,
    maxOrders:         strat.maxOrders,
    referencePrice:    s.referencePrice,
    highestPrice:      s.highestPrice,
    trailingStopPrice: s.trailingStopPrice,
    cooldownUntil:     s.cooldownUntil,
    buyTrigger,
    avgDownTrigger,
    sellTrigger,
    stopLossTrigger,
    plPct,
    plIdr,
    indicators,
  });

  // Status log
  if (isHolding) {
    const trailTag = s.trailingStopPrice ? ` | Trail: ${fPrice(s.trailingStopPrice, coin)}` : "";
    log("INFO", coin.symbol,
      `${fPrice(currentPrice, coin)} ${tag} | DCA ${s.orderCount}/${strat.maxOrders} | Avg: ${fPrice(s.buyPrice, coin)} | P/L: ${plPct.toFixed(2)}%${trailTag}`
    );
  } else if (inCooldown) {
    log("INFO", coin.symbol, `${fPrice(currentPrice, coin)} | ⏳ COOLDOWN ${cooldownSec} detik — recovery setelah stop loss`);
  } else {
    log("INFO", coin.symbol,
      `${fPrice(currentPrice, coin)} ${tag} | Idle | Trigger beli: ${fPrice(buyTrigger, coin)} (-${strat.BUY_DROP_PERCENT}%)`
    );
  }

  // ── 1. TRAILING STOP — lock profit ────────────────────────
  if (isHolding && s.trailingStopPrice && currentPrice <= s.trailingStopPrice) {
    const lockPct = ((currentPrice - s.buyPrice) / s.buyPrice * 100).toFixed(2);
    log("SELL", coin.symbol, `Trailing stop! ${fPrice(currentPrice, coin)} ≤ ${fPrice(s.trailingStopPrice, coin)} | Lock profit ${lockPct}%`);
    const ok = await placeSellOrder(coin, currentPrice, `Trailing stop (lock ${lockPct}%)`);
    if (ok) { s.referencePrice = currentPrice; s.cycleCount = 0; }
    return;
  }

  // ── 2. STOP LOSS FIXED — lindungi modal ───────────────────
  if (isHolding && stopLossTrigger && currentPrice <= stopLossTrigger) {
    log("STOP", coin.symbol, `Stop loss! ${fPrice(currentPrice, coin)} ≤ ${fPrice(stopLossTrigger, coin)} | ${s.orderCount} order DCA dilikuidasi`);
    const ok = await placeSellOrder(coin, currentPrice, `Stop loss -${strat.STOP_LOSS_PERCENT}%`);
    if (ok) {
      s.referencePrice = currentPrice;
      s.cycleCount     = 0;
      s.cooldownUntil  = Date.now() + CONFIG.COOLDOWN_MS;
      saveCooldown(coin.symbol, s.cooldownUntil);  // ← simpan ke file agar persist setelah restart
      log("WARN", coin.symbol, `Cooldown aktif — tidak beli ${CONFIG.COOLDOWN_MS / 60000} menit`);
    }
    return;
  }

  // ── 3. CLAUDE BILANG JUAL ─────────────────────────────────
  if (isHolding && strat.action === "SELL" && strat.confidence >= 60) {
    log("SELL", coin.symbol, `Claude SELL (conf: ${strat.confidence}%) | ${s.orderCount} order DCA dijual`);
    const ok = await placeSellOrder(coin, currentPrice, `Claude SELL signal`);
    if (ok) s.referencePrice = currentPrice;
    return;
  }

  // ── 4. TARGET PROFIT DARI AVG BUY ─────────────────────────
  if (isHolding && sellTrigger && currentPrice >= sellTrigger) {
    log("SELL", coin.symbol, `Target +${strat.SELL_RISE_PERCENT}% dari avg! Jual ${s.orderCount} order DCA`);
    const ok = await placeSellOrder(coin, currentPrice, `Target +${strat.SELL_RISE_PERCENT}% (avg DCA)`);
    if (ok) s.referencePrice = currentPrice;
    return;
  }

  // Semua logic beli di bawah — skip jika cooldown aktif
  if (inCooldown) return;

  // ── 5. AVERAGE DOWN — harga turun lagi dari avg ────────────
  if (canDCA && avgDownTrigger && currentPrice <= avgDownTrigger) {
    if (strat.sentiment === "BEARISH" && strat.confidence >= 80) {
      log("WARN", coin.symbol, `Average down skip — BEARISH ${strat.confidence}%`);
      return;
    }
    log("BUY", coin.symbol, `Average down! -${strat.BUY_DROP_PERCENT}% dari avg. Order #${s.orderCount + 1}/${strat.maxOrders}`);
    await placeBuyOrder(coin, currentPrice);
    return;
  }

  // ── 6. CLAUDE BUY SEKARANG (confidence tinggi) ────────────
  if (!isHolding && strat.action === "BUY" && strat.confidence >= 75) {
    log("BUY", coin.symbol, `Claude BUY sekarang (conf: ${strat.confidence}%) — DCA Order #1`);
    const ok = await placeBuyOrder(coin, currentPrice);
    if (ok) s.referencePrice = currentPrice;
    return;
  }

  // ── 7. HARGA TURUN KE TRIGGER (order pertama) ─────────────
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

// Bug #1: flag mencegah dua cycle berjalan bersamaan
let isProcessing = false;

async function runAll() {
  // Bug #1: skip kalau cycle sebelumnya belum selesai
  if (isProcessing) {
    log("WARN", null, "Cycle sebelumnya masih berjalan — skip");
    return;
  }
  isProcessing = true;

  try {
    mainCycleCount++;

    // Fetch Fear & Greed + CoinGecko setiap analysis interval
    if (mainCycleCount % CONFIG.CLAUDE_ANALYSIS_INTERVAL === 1) {
      log("INFO", null, "Mengambil Fear & Greed + CoinGecko...");
      [fearGreedData, coinGeckoData, cmcData] = await Promise.all([
        fetchFearGreed(),
        fetchCoinGecko(),
        fetchCoinMarketCap(),
      ]);
      if (fearGreedData) {
        const fgIcon =
          fearGreedData.value <= 24 ? "🟢" :
          fearGreedData.value <= 49 ? "🟡" :
          fearGreedData.value <= 75 ? "🟠" : "🔴";
        log("INFO", null, `${fgIcon} Fear & Greed: ${fearGreedData.value} — ${fearGreedData.classification}`);
        broadcast({ type: "feargreed", data: fearGreedData });
      }
      if (cmcData) broadcast({ type: "marketintel", cmc: cmcData });
    }

    // Update saldo setiap analysis interval
    if (mainCycleCount % CONFIG.CLAUDE_ANALYSIS_INTERVAL === 1) {
      await fetchBalance();
    }

    // Jalankan setiap koin (berurutan untuk menghindari rate limit)
    for (const coin of COINS) {
      await runCoin(coin);
    }
  } finally {
    // Bug #1: selalu reset flag meski terjadi error
    isProcessing = false;
  }
}

async function fetchBalance() {
  if (CONFIG.API_KEY === "ISI_API_KEY_KAMU") return;
  try {
    const info = await privateRequest("getInfo");
    if (info) {
      const idr = parseFloat(info.balance.idr || 0);
      const coins_bal = {};
      for (const c of COINS) {
        coins_bal[c.symbol] = parseFloat(info.balance[c.symbol] || 0);
      }
      balanceData = { idr, coins: coins_bal, updatedAt: Date.now() };
      broadcast({ type: "balance", balance: balanceData });
    }
  } catch (_) {}
}

function logHourlySummary() {
  const stats = loadStats();
  let totalTrades = 0, totalProfit = 0, bestTrade = 0, worstTrade = 0, winTrades = 0;
  for (const sym of Object.keys(stats)) {
    const s = stats[sym];
    totalTrades += s.totalTrades   || 0;
    totalProfit += (s.totalProfit  || 0) + (s.totalLoss || 0);
    winTrades   += s.winTrades     || 0;
    if ((s.bestTrade  || 0) > bestTrade)  bestTrade  = s.bestTrade;
    if ((s.worstTrade || 0) < worstTrade) worstTrade = s.worstTrade;
  }
  const winRate = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(1) : "0.0";
  console.log(`[RINGKASAN] ${"═".repeat(34)}`);
  console.log(`[RINGKASAN] Total trade  : ${totalTrades}`);
  console.log(`[RINGKASAN] Win rate     : ${winRate}%`);
  console.log(`[RINGKASAN] Total profit : Rp${Math.round(totalProfit).toLocaleString("id-ID")}`);
  console.log(`[RINGKASAN] Best trade   : Rp${Math.round(bestTrade).toLocaleString("id-ID")}`);
  console.log(`[RINGKASAN] Worst trade  : Rp${Math.round(worstTrade).toLocaleString("id-ID")}`);
  console.log(`[RINGKASAN] ${"═".repeat(34)}`);
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

  // Muat trades dari file ke tradeLog
  const savedTrades = loadTrades();
  tradeLog.push(...savedTrades);
  if (savedTrades.length > 0) {
    log("INFO", null, `Dimuat ${savedTrades.length} trade dari trades.json`);
  }

  if (CONFIG.API_KEY !== "ISI_API_KEY_KAMU") {
    const info = await privateRequest("getInfo");
    if (info) {
      const idr      = parseFloat(info.balance.idr || 0);
      const coinBals = COINS.map(c => `${c.name}: ${Math.floor(info.balance[c.symbol] || 0).toLocaleString("id-ID")}`).join(" | ");
      log("INFO", null, `Saldo IDR : Rp${idr.toLocaleString("id-ID")}`);
      log("INFO", null, `Saldo koin: ${coinBals}`);
      // Simpan ke balanceData agar tersedia di SSE init
      const coins_bal = {};
      for (const c of COINS) coins_bal[c.symbol] = parseFloat(info.balance[c.symbol] || 0);
      balanceData = { idr, coins: coins_bal, updatedAt: Date.now() };
    }
  }

  // Start dashboard server
  app.listen(CONFIG.DASHBOARD_PORT, () => {
    log("INFO", null, `Dashboard: http://localhost:${CONFIG.DASHBOARD_PORT}`);
  });

  // Bug #2: muat cooldown dari file untuk semua koin saat bot start
  for (const coin of COINS) {
    const saved = loadCooldown(coin.symbol);
    if (saved) {
      state[coin.symbol].cooldownUntil = saved;
      const sisaSec = Math.ceil((saved - Date.now()) / 1000);
      log("WARN", coin.symbol, `Cooldown dimuat dari file — sisa ${sisaSec} detik`);
    }
  }

  // Log ringkasan setiap 1 jam
  setInterval(logHourlySummary, 3600000);

  log("INFO", null, `${COINS.length} koin aktif, cek setiap ${CONFIG.CHECK_INTERVAL_MS / 1000} detik`);
  log("INFO", null, "Tekan Ctrl+C untuk hentikan");
  console.log("-".repeat(62));

  // Bug #1: gunakan setTimeout rekursif — cycle berikutnya dimulai
  // SETELAH cycle sekarang selesai, bukan bersamaan
  async function loop() {
    await runAll();
    setTimeout(loop, CONFIG.CHECK_INTERVAL_MS);
  }
  loop();
}

main().catch(err => {
  log("ERROR", null, `Fatal: ${err.message}`);
  process.exit(1);
});
