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

  // Trailing stop aktif setelah profit bersih ≥ 2%
  // (profit 2% - fee 0.6% = 1.4% profit bersih minimal)
  TRAILING_ACTIVATE_PCT:   2.0,
  // Trail 1% di bawah highest — beri ruang fluktuasi normal DOGE
  TRAILING_STOP_PCT:       1.0,

  COOLDOWN_MS:          300000,  // cooldown 5 menit setelah stop loss

  // 30 detik cukup untuk spot trading DOGE — hemat API call, kurangi risiko rate limit
  CHECK_INTERVAL_MS:     30000,
  CLAUDE_ANALYSIS_INTERVAL: 16,  // Analisis Claude tiap ~8 menit (16 × 30 detik) — hemat kredit
  // Skip analisis jika harga bergerak < threshold % DAN tidak sedang holding
  CLAUDE_SKIP_THRESHOLD_PCT: 0.2,

  // Mode all-in: beli semua saldo tersedia sekaligus dalam 1 transaksi
  // false = DCA bertahap (mode lama), true = beli semua sekaligus
  ALL_IN_MODE: true,

  // Auto Safe Mode — pause trading saat market crash
  SAFE_MODE_ENABLED:      true,
  SAFE_MODE_BTC_DROP:     5.0,      // aktif kalau BTC turun > 5% dari data awal
  SAFE_MODE_DOGE_DROP:    8.0,      // aktif kalau DOGE turun > 8% dalam ~12 cycle
  SAFE_MODE_PANIC_LEVEL:  2,        // aktif kalau panic level ≥ 2
  SAFE_MODE_DURATION_MS:  3600000,  // safe mode berlangsung 1 jam

  DRY_RUN: false,                // true = simulasi | false = trading sungguhan
  DASHBOARD_PORT: 3000,
};

// ============================================================
// 🪙  DAFTAR KOIN  (tambah/hapus sesuai kebutuhan)
// ============================================================
const COINS = [
  { symbol: "doge", pair: "doge_idr", coingeckoId: "dogecoin", name: "DOGE", priceDecimals: 0, capitalPct: 1.0 },
  // Untuk tambah koin: { symbol:"shib", pair:"shib_idr", coingeckoId:"shiba-inu", name:"SHIB", priceDecimals:0, capitalPct:0.4 }
  // Pastikan total capitalPct = 1.0
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
    volumeHistory:     [],
    cycleCount:        0,
    lastAnalysisPrice: null,  // untuk skip guard Claude
    strategy: {
      action:           "HOLD",
      BUY_DROP_PERCENT:  2,
      SELL_RISE_PERCENT: 3,
      // Stop loss 4% — memberi ruang fluktuasi normal DOGE
      // Fee total 0.6%, kerugian bersih maksimal ~4.6%
      STOP_LOSS_PERCENT: 4.0,
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
const COOLDOWN_FILE      = path.join(__dirname, "cooldown.json");
const TRADES_FILE        = path.join(__dirname, "trades.json");
const STATS_FILE         = path.join(__dirname, "stats.json");
const DAILY_REPORTS_FILE = path.join(__dirname, "daily_reports.json");
const EVALUATIONS_FILE   = path.join(__dirname, "evaluations.json");

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

// ── Candle aggregation (1 menit) ─────────────────────────────
const CANDLE_MS   = 60000;
const MAX_CANDLES = 120;   // 2 jam data
const candleState = {};
for (const coin of COINS) {
  candleState[coin.symbol] = { candles: [], current: null };
}

function updateCandles(coinSymbol, price, ts) {
  const cs       = candleState[coinSymbol];
  const candleTs = Math.floor(ts / CANDLE_MS) * CANDLE_MS;
  if (!cs.current || cs.current.tsMs !== candleTs) {
    if (cs.current) {
      const { tsMs, ...rest } = cs.current;   // buang tsMs sebelum disimpan
      cs.candles.push(rest);
      if (cs.candles.length > MAX_CANDLES) cs.candles.shift();
    }
    cs.current = { tsMs: candleTs, time: Math.floor(candleTs / 1000), open: price, high: price, low: price, close: price };
  } else {
    if (price > cs.current.high) cs.current.high = price;
    if (price < cs.current.low)  cs.current.low  = price;
    cs.current.close = price;
  }
}

function getCandles(coinSymbol) {
  const cs = candleState[coinSymbol];
  const list = [...cs.candles];
  if (cs.current) list.push({ time: cs.current.time, open: cs.current.open, high: cs.current.high, low: cs.current.low, close: cs.current.close });
  return list;
}

// ── Log buffer (dikirim ke dashboard) ────────────────────────
const logBuffer = [];  // max 200 entri

// ── Global data ──────────────────────────────────────────────
let fearGreedData    = null;
let coinGeckoData    = {};
let cmcData          = null;
let balanceData      = null;
let mainCycleCount   = 0;
const tradeLog       = [];   // max 500 transaksi (dimuat dari file saat start)
const botStartTime   = Date.now();
const btcPriceHistory = [];  // max 100 titik untuk kalkulasi korelasi BTC-DOGE

// Sentimen tambahan
let cryptoPanicData  = null;
let googleTrendsData = null;
let augmentoData     = null;

// Safe mode global state
let safeModeUntil  = 0;
let safeModeReason = "";

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
        candles:           getCandles(c.symbol),
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

// CoinGecko Community Sentiment DOGE — gratis, tanpa key
// Menggunakan sentiment_votes_up/down + community_data sebagai proxy berita
async function fetchCryptoPanic() {
  try {
    const res = await axios.get(
      "https://api.coingecko.com/api/v3/coins/dogecoin",
      {
        params: { localization: false, tickers: false, market_data: true, community_data: true, developer_data: false },
        timeout: 8000,
      }
    );
    const d   = res.data;
    const up  = d.sentiment_votes_up_percentage   || 50;
    const dn  = d.sentiment_votes_down_percentage || 50;
    const score = up / 100;

    // Reddit activity sebagai proxy "headline panas"
    const reddit = d.community_data || {};
    const redditPosts    = reddit.reddit_average_posts_48h    || 0;
    const redditComments = reddit.reddit_average_comments_48h || 0;
    const activity = redditPosts + redditComments > 50 ? "HIGH" : "NORMAL";

    const headlines = [
      `Community sentiment: ${up.toFixed(0)}% bullish / ${dn.toFixed(0)}% bearish`,
      `Reddit activity (48h): ${redditPosts.toFixed(0)} posts, ${redditComments.toFixed(0)} comments`,
      activity === "HIGH" ? "Reddit sedang ramai — pantau pergerakan harga" : "Reddit tenang",
    ];

    return {
      score,
      bullish: Math.round(up),
      bearish: Math.round(dn),
      important: activity === "HIGH" ? 1 : 0,
      sentiment: score > 0.6 ? "BULLISH" : score < 0.4 ? "BEARISH" : "NEUTRAL",
      headlines,
      updatedAt: Date.now(),
    };
  } catch (err) {
    log("WARN", null, `CoinGecko sentiment gagal: ${err.message} — pakai cache`);
    return cryptoPanicData;
  }
}

// CoinGecko Trending — apakah DOGE masuk top-7 trending search (gratis, tanpa key)
async function fetchGoogleTrends() {
  try {
    const res = await axios.get("https://api.coingecko.com/api/v3/search/trending", { timeout: 8000 });
    const coins = res.data?.coins || [];
    const rank  = coins.findIndex(c => c.item?.id === "dogecoin");
    const isDogeTrending = rank >= 0;
    const value = isDogeTrending ? (7 - rank) * 15 : 0;  // skor 0–90 berdasarkan posisi
    return {
      isDogeTrending,
      trending: isDogeTrending ? "TRENDING" : "NORMAL",
      rank:     isDogeTrending ? rank + 1 : null,
      value,
      updatedAt: Date.now(),
    };
  } catch (err) {
    log("WARN", null, `CoinGecko Trending gagal: ${err.message} — pakai cache`);
    return googleTrendsData;
  }
}

// Alternative.me Fear & Greed 7-hari — proxy sentimen crypto (gratis, tanpa key)
async function fetchAugmento() {
  try {
    const res = await axios.get("https://api.alternative.me/fng/?limit=7&format=json", { timeout: 8000 });
    const data = (res.data?.data || []).reverse();  // urut lama ke baru
    if (data.length === 0) return augmentoData;
    const scores    = data.map(d => parseInt(d.value, 10) / 100);  // 0–1
    const latest    = scores[scores.length - 1];
    const avg7d     = scores.reduce((a, b) => a + b, 0) / scores.length;
    const firstHalf = scores.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
    const secHalf   = scores.slice(4).reduce((a, b) => a + b, 0) / Math.max(scores.slice(4).length, 1);
    const trend     = secHalf > firstHalf + 0.05 ? "IMPROVING" : secHalf < firstHalf - 0.05 ? "WORSENING" : "STABLE";
    return {
      score:     parseFloat(latest.toFixed(3)),
      avg7d:     parseFloat(avg7d.toFixed(3)),
      trend,
      label:     data[data.length - 1]?.value_classification || "",
      sentiment: latest > 0.6 ? "BULLISH" : latest < 0.4 ? "BEARISH" : "NEUTRAL",
      updatedAt: Date.now(),
    };
  } catch (err) {
    log("WARN", null, `Fear&Greed 7d gagal: ${err.message} — pakai cache`);
    return augmentoData;
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

  // ── Skip guard: hemat kredit jika harga tidak banyak bergerak ────
  const isHoldingNow = s.buyPrice !== null;
  const inCooldownNow = s.cooldownUntil && Date.now() < s.cooldownUntil;
  if (!isHoldingNow && !inCooldownNow && s.lastAnalysisPrice) {
    const movePct = Math.abs((ticker.last - s.lastAnalysisPrice) / s.lastAnalysisPrice) * 100;
    if (movePct < CONFIG.CLAUDE_SKIP_THRESHOLD_PCT) {
      log("AI", coin.symbol, `⏭ Skip analisis (harga bergerak hanya ${movePct.toFixed(2)}% < ${CONFIG.CLAUDE_SKIP_THRESHOLD_PCT}%)`);
      return false;
    }
  }

  // ── Statistik ringkas ───────────────────────────────────────────
  const history  = s.priceHistory.slice(-8);
  const prices   = history.map(p => p.price);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
  const volat    = ((Math.max(...prices) - Math.min(...prices)) / avgPrice) * 100;
  const avgChg   = history.map(p => p.change).reduce((a, b) => a + b, 0) / history.length;
  const trend    = avgChg > 0.05 ? "NAIK" : avgChg < -0.05 ? "TURUN" : "SIDEWAYS";
  // 5 harga terakhir sebagai array ringkas (tanpa timestamp)
  const recentPrices = s.priceHistory.slice(-5).map(p => Math.round(p.price)).join(", ");

  // ── Sentimen & data eksternal (ringkas) ────────────────────────
  const fg     = fearGreedData;
  const fgLine = fg ? `FG:${fg.value}(${fg.classification})` : "FG:N/A";

  const cg = coinGeckoData[coin.symbol];
  const cgLine = cg
    ? `CG 24h:${cg.change24h?.toFixed(1)}% 7d:${cg.change7d?.toFixed(1)}%`
    : "CG:N/A";

  const cmc = cmcData?.coins?.[coin.symbol];
  const cmcLine = cmc
    ? `CMC #${cmc.rank} 1h:${cmc.change1h?.toFixed(1)}% 24h:${cmc.change24h?.toFixed(1)}% 7d:${cmc.change7d?.toFixed(1)}% volChg:${cmc.volumeChange24h?.toFixed(0)}%`
    : "CMC:N/A";

  // ── Posisi & cooldown ──────────────────────────────────────────
  const cooldownRemainSec = inCooldownNow ? Math.ceil((s.cooldownUntil - Date.now()) / 1000) : 0;
  const trailLine = s.trailingStopPrice
    ? `trail@${Math.round(s.trailingStopPrice)}`
    : "trail:off";
  const posisi = isHoldingNow
    ? `HOLD ${fAmount(s.coinHeld, coin)} avg@${Math.round(s.buyPrice)} PL:${(((ticker.last - s.buyPrice) / s.buyPrice) * 100).toFixed(2)}% DCA:${s.orderCount}/${s.strategy.maxOrders} ${trailLine}`
    : inCooldownNow
      ? `IDLE cooldown:${cooldownRemainSec}s`
      : `IDLE ready`;

  const hardCap = Math.floor((CONFIG.TOTAL_MODAL_IDR - CONFIG.RESERVE_IDR) / CONFIG.MAX_ORDER_IDR);

  // Sentimen tambahan (ringkas)
  const cpLine  = cryptoPanicData
    ? `CP:${cryptoPanicData.sentiment}(${(cryptoPanicData.score * 100).toFixed(0)}%) bull:${cryptoPanicData.bullish} bear:${cryptoPanicData.bearish}`
    : "CP:N/A";
  const gtLine  = googleTrendsData ? `GT:${googleTrendsData.trending}` : "GT:N/A";
  const augLine = augmentoData
    ? `AUG:${augmentoData.sentiment}(${(augmentoData.score * 100).toFixed(0)}%) ${augmentoData.trend}`
    : "AUG:N/A";

  const prompt = `Analis trading ${coin.name}/IDR Indodax. Data:
${fgLine} | ${cgLine}
${cmcLine}
${cpLine} | ${gtLine} | ${augLine}
IDX: last=${Math.round(ticker.last)} bid=${Math.round(ticker.buy)} ask=${Math.round(ticker.sell)} H=${Math.round(ticker.high)} L=${Math.round(ticker.low)}
Recent(5): [${recentPrices}] avg=${Math.round(avgPrice)} vol=${volat.toFixed(1)}% trend=${trend}
Posisi: ${posisi}
Param: drop-${s.strategy.BUY_DROP_PERCENT}% target+${s.strategy.SELL_RISE_PERCENT}% stop-${s.strategy.STOP_LOSS_PERCENT}% trail${CONFIG.TRAILING_ACTIVATE_PCT}%/trail${CONFIG.TRAILING_STOP_PCT}% cooldown${CONFIG.COOLDOWN_MS/60000}m

Strategi SWING TRADING DOGE/IDR Indodax:
- Fee 0.6% round trip → target profit MINIMAL 1.5% bersih
- Jangan BUY kalau profit target < 1.5% setelah fee
- DOGE spot = tidak ada leverage, prioritas modal aman
- Fear & Greed < 20 = sinyal beli kuat (Extreme Fear bounce)
- RSI < 35 = oversold → lebih agresif BUY
- RSI > 65 = overbought → lebih agresif SELL
- Volume rendah + sideways = HOLD (tidak ada momentum)
- BTC turun → DOGE biasanya ikut → hati-hati BUY
- Target swing realistis: +2-5% per trade, hold 2-24 jam
- Confidence: BUY ≥ 70% saat kondisi bagus, HOLD kalau ragu

JSON only (no other text):
{"action":"BUY"|"SELL"|"HOLD","buy_drop_percent":<0.5-5.0>,"sell_rise_percent":<1.5-8.0>,"stop_loss_percent":<2.0-5.0>,"max_orders":<1-${hardCap}>,"sentiment":"BULLISH"|"BEARISH"|"NEUTRAL"|"VOLATILE","confidence":<0-100>,"reasoning":"<max 50 kata Indonesia>"}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await claudeClient.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 180,
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
        // Minimum 1.5% untuk cover fee 0.6% + profit bersih 0.9%
        SELL_RISE_PERCENT: Math.max(1.5, Math.min(8.0, parseFloat(a.sell_rise_percent) || s.strategy.SELL_RISE_PERCENT)),
        // Minimum 2.0% stop loss untuk DOGE — fluktuasi normal 1-2% per jam
        STOP_LOSS_PERCENT: Math.max(2.0, Math.min(5.0, parseFloat(a.stop_loss_percent) || s.strategy.STOP_LOSS_PERCENT)),
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

      // All-in mode: paksa maxOrders = 1 (hanya 1 transaksi, tidak ada DCA)
      if (CONFIG.ALL_IN_MODE) {
        s.strategy.maxOrders = 1;
      }

      // Simpan harga saat analisis untuk skip guard berikutnya
      s.lastAnalysisPrice = ticker.last;

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
async function placeBuyOrder(coin, price, confidenceOverride = null) {
  const s          = state[coin.symbol];
  const confidence = confidenceOverride ?? s.strategy.confidence ?? 50;
  const balance    = await getBalance(coin);
  if (!balance) return false;

  // Gunakan alokasi modal per koin (kapital yang diizinkan untuk koin ini)
  const coinBudget = getAllocatedCapital(coin);
  const rawAvail   = balance.idr - CONFIG.RESERVE_IDR;
  const available  = CONFIG.ALL_IN_MODE
    ? rawAvail
    : Math.min(rawAvail, coinBudget - s.totalIdrSpent);

  if (available <= 0 || available < 10000) {
    log("WARN", coin.symbol, `Saldo tidak cukup setelah reserve — Saldo: Rp${balance.idr.toLocaleString("id-ID")} | Reserve: Rp${CONFIG.RESERVE_IDR.toLocaleString("id-ID")} | Tersedia: Rp${Math.max(0, available).toLocaleString("id-ID")}`);
    return false;
  }

  // Position sizing berdasarkan confidence Claude
  // ALL_IN_MODE: selalu 99% | DCA mode: min 30% - max 99% sesuai confidence
  let sizePct;
  if (CONFIG.ALL_IN_MODE) {
    sizePct = 0.99;
  } else {
    sizePct = Math.min(0.99, Math.max(0.30, confidence / 100));
    // Boost sizing kalau whale accumulation terdeteksi
    const whaleSig = detectWhaleAccumulation(s.priceHistory, s.volumeHistory);
    if (whaleSig.isAccumulating) sizePct = Math.min(0.99, sizePct + 0.15);
  }

  const maxUsable = CONFIG.ALL_IN_MODE
    ? available * 0.99
    : Math.min(available * sizePct, CONFIG.MAX_ORDER_IDR * 2);
  const idrToUse  = maxUsable;

  log("INFO", coin.symbol, `Position sizing: conf=${confidence}% → ${(sizePct * 100).toFixed(0)}% | Saldo: Rp${balance.idr.toLocaleString("id-ID")} | Order: Rp${Math.round(idrToUse).toLocaleString("id-ID")}`);

  const amount      = Math.floor(idrToUse / price);
  const priceStr    = coin.priceDecimals > 0 ? price.toFixed(coin.priceDecimals) : Math.round(price).toString();
  const orderLabel  = CONFIG.ALL_IN_MODE ? "ALL-IN" : `Order #${s.orderCount + 1}/${s.strategy.maxOrders}`;

  log("BUY", coin.symbol, `[${CONFIG.DRY_RUN ? "DRY" : "LIVE"}] ${orderLabel} BELI ${fAmount(amount, coin)} @ ${fPrice(price, coin)} (Rp${Math.round(idrToUse).toLocaleString("id-ID")})`);

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
// 🚨  PANIC DETECTOR — deteksi dump mendadak
// ============================================================
function detectPanic(priceHistory, volumeHistory) {
  if (priceHistory.length < 10) return { isPanic: false, level: 0, signal: "NORMAL", dropPct: 0, volSpike: 1 };
  const prices  = priceHistory.slice(-10).map(p => p.price);
  const vols    = volumeHistory.slice(-10);
  const prev5   = prices.slice(0, 5);
  const last5   = prices.slice(5);
  const avgPrev = prev5.reduce((a, b) => a + b, 0) / 5;
  const avgLast = last5.reduce((a, b) => a + b, 0) / 5;
  const dropPct = ((avgLast - avgPrev) / avgPrev) * 100;
  const avgVol   = vols.slice(0, 7).reduce((a, b) => a + b, 0) / (7 || 1) || 1;
  const lastVol  = vols[vols.length - 1] || 0;
  const volSpike = lastVol / avgVol;
  let level = 0;
  if (dropPct < -1.5 && volSpike > 1.5) level = 1;
  if (dropPct < -3.0 && volSpike > 2.0) level = 2;
  if (dropPct < -5.0 && volSpike > 3.0) level = 3;
  return {
    isPanic:  level > 0,
    level,
    dropPct:  parseFloat(dropPct.toFixed(2)),
    volSpike: parseFloat(volSpike.toFixed(2)),
    signal:   level === 0 ? "NORMAL" : level === 1 ? "MILD_DUMP" : level === 2 ? "PANIC_SELL" : "CRASH",
  };
}

// ============================================================
// 🐋  WHALE ACCUMULATION SIGNAL
// ============================================================
function detectWhaleAccumulation(priceHistory, volumeHistory) {
  if (priceHistory.length < 20 || volumeHistory.length < 20) {
    return { isAccumulating: false, signal: "UNKNOWN", priceRange: 0, volTrend: 1, confidence: 0 };
  }
  const prices       = priceHistory.slice(-20).map(p => p.price);
  const vols         = volumeHistory.slice(-20);
  const priceRange   = (Math.max(...prices) - Math.min(...prices)) / Math.min(...prices) * 100;
  const isSideways   = priceRange < 2.0;
  const firstHalfV   = vols.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
  const secondHalfV  = vols.slice(10).reduce((a, b) => a + b, 0) / 10;
  const volTrend     = secondHalfV / (firstHalfV || 1);
  const isVolRising  = volTrend > 1.2;
  const maxDrop      = Math.min(...prices.map((p, i) => i > 0 ? (p - prices[i - 1]) / prices[i - 1] * 100 : 0));
  const noPanic      = maxDrop > -2.0;
  const isAccumulating = isSideways && isVolRising && noPanic;
  return {
    isAccumulating,
    signal:     isAccumulating ? "WHALE_ACCUMULATING" : "NORMAL",
    priceRange: parseFloat(priceRange.toFixed(2)),
    volTrend:   parseFloat(volTrend.toFixed(2)),
    confidence: isAccumulating ? Math.min(100, Math.round((volTrend - 1) * 100 + 50)) : 0,
  };
}

// ============================================================
// 🪤  WHALE TRAP DETECTOR
// ============================================================
function detectWhaleTrap(priceHistory) {
  if (priceHistory.length < 6) return { isTrap: false, type: "NONE", spike: 0, retrace: 0 };
  const prices    = priceHistory.slice(-6).map(p => p.price);
  const last      = prices[prices.length - 1];
  const low       = Math.min(...prices.slice(0, 5));
  const high      = Math.max(...prices.slice(0, 5));
  const spike     = (high - low) / low * 100;
  const retrace   = (high - last) / (high - low || 1) * 100;
  const isBullTrap = spike > 2 && retrace > 70 && last < (low + (high - low) * 0.3);
  const isBearTrap = spike > 2 && last > (low + (high - low) * 0.7) && prices[0] > low * 1.01;
  return {
    isTrap:   isBullTrap || isBearTrap,
    type:     isBullTrap ? "BULL_TRAP" : isBearTrap ? "BEAR_TRAP" : "NONE",
    spike:    parseFloat(spike.toFixed(2)),
    retrace:  parseFloat(retrace.toFixed(2)),
  };
}

// ============================================================
// 📊  SIDEWAYS DETECTOR — pause beli jika range sempit
// ============================================================
function isSidewaysMarket(priceHistory, threshold = 0.4) {
  if (priceHistory.length < 20) return false;
  const prices = priceHistory.slice(-20).map(p => p.price);
  const high   = Math.max(...prices);
  const low    = Math.min(...prices);
  return (high - low) / low * 100 < threshold;
}

// ============================================================
// 🛡️  SAFE MODE — pause trading saat crash
// ============================================================
function checkAndActivateSafeMode(panicData, priceHistory) {
  if (!CONFIG.SAFE_MODE_ENABLED) return false;
  if (Date.now() < safeModeUntil) return true;  // sudah aktif

  if (priceHistory.length < 12) return false;
  const prices    = priceHistory.slice(-12).map(p => p.price);
  const drop1h    = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
  const btcDrop1h = btcPriceHistory.length >= 2
    ? ((btcPriceHistory[btcPriceHistory.length - 1] - btcPriceHistory[0]) / btcPriceHistory[0] * 100)
    : 0;

  let reason = "";
  if (drop1h < -CONFIG.SAFE_MODE_DOGE_DROP)
    reason = `DOGE crash ${drop1h.toFixed(2)}%`;
  else if (btcDrop1h < -CONFIG.SAFE_MODE_BTC_DROP)
    reason = `BTC crash ${btcDrop1h.toFixed(2)}%`;
  else if (panicData.level >= CONFIG.SAFE_MODE_PANIC_LEVEL)
    reason = `Panic level ${panicData.level} (${panicData.signal})`;

  if (reason) {
    safeModeUntil  = Date.now() + CONFIG.SAFE_MODE_DURATION_MS;
    safeModeReason = reason;
    log("ERROR", null, `🛡️ SAFE MODE AKTIF! ${reason} — pause 1 jam`);
    broadcast({ type: "safe_mode", active: true, reason, until: safeModeUntil });
    return true;
  }
  return false;
}

// ============================================================
// 💰  MULTI-COIN CAPITAL ALLOCATOR
// ============================================================
function getAllocatedCapital(coin) {
  const totalModal = CONFIG.TOTAL_MODAL_IDR - CONFIG.RESERVE_IDR;
  const pct        = coin.capitalPct || (1 / COINS.length);
  return Math.floor(totalModal * pct);
}

async function rebalanceCapital() {
  for (const coin of COINS) {
    const s         = state[coin.symbol];
    const allocated = getAllocatedCapital(coin);
    const pct       = allocated > 0 ? s.totalIdrSpent / allocated * 100 : 0;
    if (pct > 120) {
      log("WARN", coin.symbol, `Over-allocated: ${pct.toFixed(0)}% dari budget Rp${allocated.toLocaleString("id-ID")}`);
    }
  }
}

// ============================================================
// 📊  C1: DETEKSI MARKET REGIME
// ============================================================
function detectMarketRegime(priceHistory) {
  if (priceHistory.length < 30) return { regime: "UNKNOWN", strength: 0 };
  const prices = priceHistory.slice(-30).map(p => p.price);
  const ema10 = prices.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const ema30 = prices.reduce((a, b) => a + b, 0) / 30;
  const high  = Math.max(...prices);
  const low   = Math.min(...prices);
  const range = high - low;
  const mid   = (high + low) / 2;
  const last  = prices[prices.length - 1];

  // Hitung slope EMA10 (perubahan relatif 5 candle terakhir)
  const ema10Prev = prices.slice(-15, -5).reduce((a, b) => a + b, 0) / 10;
  const slope = (ema10 - ema10Prev) / ema10Prev * 100;

  let regime, strength;
  if (ema10 > ema30 * 1.005 && slope > 0.1) {
    regime   = "UPTREND";
    strength = Math.min(100, Math.abs(slope) * 20);
  } else if (ema10 < ema30 * 0.995 && slope < -0.1) {
    regime   = "DOWNTREND";
    strength = Math.min(100, Math.abs(slope) * 20);
  } else if (range / mid < 0.02) {
    regime   = "SIDEWAYS";
    strength = Math.min(100, (1 - range / mid / 0.02) * 100);
  } else {
    regime   = "VOLATILE";
    strength = Math.min(100, (range / mid / 0.02) * 50);
  }
  const posInRange = range > 0 ? ((last - low) / range) * 100 : 50;
  return { regime, strength: Math.round(strength), ema10: parseFloat(ema10.toFixed(2)), ema30: parseFloat(ema30.toFixed(2)), posInRange: Math.round(posInRange) };
}

// ============================================================
// 📊  C2: DETEKSI VOLUME ANOMALY
// ============================================================
function detectVolumeAnomaly(volumeHistory) {
  if (volumeHistory.length < 10) return { anomaly: false, ratio: 1, signal: "NORMAL" };
  const recent = volumeHistory.slice(-5);
  const baseline = volumeHistory.slice(-20, -5);
  if (baseline.length < 5) return { anomaly: false, ratio: 1, signal: "NORMAL" };
  const avgRecent   = recent.reduce((a, b) => a + b, 0) / recent.length;
  const avgBaseline = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  if (avgBaseline === 0) return { anomaly: false, ratio: 1, signal: "NORMAL" };
  const ratio = avgRecent / avgBaseline;
  let signal = "NORMAL";
  if (ratio >= 2.5)      signal = "VOLUME_SPIKE";
  else if (ratio >= 1.5) signal = "HIGH_VOLUME";
  else if (ratio <= 0.4) signal = "LOW_VOLUME";
  return { anomaly: ratio >= 1.5 || ratio <= 0.4, ratio: parseFloat(ratio.toFixed(2)), signal };
}

// ============================================================
// 📊  C3: KALKULASI SUPPORT & RESISTANCE
// ============================================================
function calcSupportResistance(priceHistory) {
  if (priceHistory.length < 20) return { support: null, resistance: null, levels: [] };
  const prices = priceHistory.slice(-50).map(p => p.price);
  const pivots = [];
  for (let i = 2; i < prices.length - 2; i++) {
    const p = prices[i];
    if (p > prices[i-1] && p > prices[i-2] && p > prices[i+1] && p > prices[i+2]) {
      pivots.push({ price: p, type: "resistance" });
    } else if (p < prices[i-1] && p < prices[i-2] && p < prices[i+1] && p < prices[i+2]) {
      pivots.push({ price: p, type: "support" });
    }
  }
  // Cluster pivot yang berdekatan (dalam 0.5%)
  const clusters = [];
  for (const pv of pivots) {
    const existing = clusters.find(c => Math.abs(c.price - pv.price) / pv.price < 0.005);
    if (existing) {
      existing.count++;
      existing.price = (existing.price * (existing.count - 1) + pv.price) / existing.count;
    } else {
      clusters.push({ price: pv.price, type: pv.type, count: 1 });
    }
  }
  clusters.sort((a, b) => b.count - a.count);
  const last        = prices[prices.length - 1];
  const supports    = clusters.filter(c => c.type === "support"    && c.price < last).sort((a, b) => b.price - a.price);
  const resistances = clusters.filter(c => c.type === "resistance" && c.price > last).sort((a, b) => a.price - b.price);
  return {
    support:    supports[0]    ? parseFloat(supports[0].price.toFixed(2))    : null,
    resistance: resistances[0] ? parseFloat(resistances[0].price.toFixed(2)) : null,
    levels:     clusters.slice(0, 5).map(c => ({ ...c, price: parseFloat(c.price.toFixed(2)) })),
  };
}

// ============================================================
// 📊  C4: BTC PRICE FETCH + BTC-DOGE KORELASI PEARSON
// ============================================================
async function fetchBTCPrice() {
  try {
    const res = await axios.get("https://indodax.com/api/ticker/btcidr", { timeout: 5000 });
    const price = parseFloat(res.data?.ticker?.last || 0);
    if (price > 0) {
      btcPriceHistory.push(price);
      if (btcPriceHistory.length > 100) btcPriceHistory.shift();
    }
  } catch (_) {}
}

function calcBTCDOGECorrelation(dogeHistory) {
  const n = Math.min(btcPriceHistory.length, dogeHistory.length, 30);
  if (n < 10) return null;
  const x = btcPriceHistory.slice(-n);
  const y = dogeHistory.slice(-n).map(p => p.price);
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num  += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const denom = Math.sqrt(denX * denY);
  if (denom === 0) return null;
  return parseFloat((num / denom).toFixed(3));
}

// ============================================================
// 📅  B2: LAPORAN HARIAN
// ============================================================
function generateDailyReport() {
  const now   = new Date();
  const label = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  const stats = loadStats();
  let totalTrades = 0, totalProfit = 0, winTrades = 0;
  const coinSummary = {};
  for (const sym of Object.keys(stats)) {
    const s = stats[sym];
    totalTrades += s.totalTrades  || 0;
    totalProfit += (s.totalProfit || 0) + (s.totalLoss || 0);
    winTrades   += s.winTrades    || 0;
    coinSummary[sym] = {
      trades:  s.totalTrades  || 0,
      profit:  Math.round((s.totalProfit || 0) + (s.totalLoss || 0)),
      winRate: s.winRate ? parseFloat(s.winRate.toFixed(1)) : 0,
    };
  }
  const winRate = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(1) : "0.0";
  const report  = {
    date: label, generatedAt: now.toISOString(),
    totalTrades, winRate: parseFloat(winRate),
    totalProfit: Math.round(totalProfit),
    coinSummary,
    balance: balanceData ? { idr: balanceData.idr } : null,
  };
  // Simpan ke file
  let reports = [];
  try { reports = JSON.parse(fs.readFileSync(DAILY_REPORTS_FILE, "utf8")); } catch (_) {}
  if (!Array.isArray(reports)) reports = [];
  const existing = reports.findIndex(r => r.date === label);
  if (existing >= 0) reports[existing] = report; else reports.push(report);
  if (reports.length > 90) reports = reports.slice(-90);
  try { fs.writeFileSync(DAILY_REPORTS_FILE, JSON.stringify(reports, null, 2)); } catch (_) {}
  log("INFO", null, `📅 Laporan harian ${label}: ${totalTrades} trade | WR: ${winRate}% | P/L: Rp${Math.round(totalProfit).toLocaleString("id-ID")}`);
  broadcast({ type: "daily_report", report });
}

// ============================================================
// 🧠  SELF-EVALUATION HARIAN — AI BELAJAR DARI HASIL TRADING
// ============================================================
async function evaluateAndLearn() {
  const recentTrades = tradeLog.slice(-20);
  if (recentTrades.length < 3) {
    log("INFO", null, "Self-eval: data trade belum cukup (min 3), skip");
    return;
  }

  let totalProfit = 0, wins = 0;
  const tradeLines = recentTrades.map(t => {
    const net = t.netProfit || 0;
    totalProfit += net;
    if (net > 0) wins++;
    return `${t.coin||"?"} ${t.type} ${t.reason||""} net:${Math.round(net)}IDR`;
  }).join("\n");

  const winRate = ((wins / recentTrades.length) * 100).toFixed(0);
  const prompt  = `Evaluator trading DOGE/IDR. ${recentTrades.length} trade terakhir:\n${tradeLines}\n\nWR:${winRate}% P/L:Rp${Math.round(totalProfit)}\n\nBerikan 3 poin evaluasi singkat (pola kesalahan, kondisi market terbaik, saran konkret). Jawab 3 kalimat Bahasa Indonesia.`;

  try {
    const response = await claudeClient.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 250,
      messages: [{ role: "user", content: prompt }],
    });
    const evalText = response.content[0].text.trim();
    log("INFO", null, `🧠 Self-eval: ${evalText}`);

    let evals = [];
    try { evals = JSON.parse(fs.readFileSync(EVALUATIONS_FILE, "utf8")); } catch (_) {}
    if (!Array.isArray(evals)) evals = [];
    evals.push({
      date:        new Date().toISOString(),
      winRate:     parseFloat(winRate),
      totalProfit: Math.round(totalProfit),
      evaluation:  evalText,
    });
    if (evals.length > 30) evals = evals.slice(-30);
    try { fs.writeFileSync(EVALUATIONS_FILE, JSON.stringify(evals, null, 2)); } catch (_) {}

    broadcast({ type: "self_eval", evaluation: evalText, winRate: parseFloat(winRate), totalProfit: Math.round(totalProfit), date: new Date().toISOString() });
  } catch (e) {
    log("WARN", null, `Self-eval error: ${e.message}`);
  }
}

function scheduleDailyReport() {
  const now   = new Date();
  const next  = new Date(now);
  next.setHours(22, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(async () => {
    generateDailyReport();
    await evaluateAndLearn();
    setInterval(async () => {
      generateDailyReport();
      await evaluateAndLearn();
    }, 24 * 3600 * 1000);
  }, delay);
  log("INFO", null, `Laporan harian dijadwalkan pukul 22:00 (${Math.round(delay / 60000)} menit lagi)`);
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
  updateCandles(coin.symbol, currentPrice, Date.now());

  // Update volume history
  const s2 = state[coin.symbol];
  if (ticker.vol_coin) {
    s2.volumeHistory.push(parseFloat(ticker.vol_coin));
    if (s2.volumeHistory.length > 50) s2.volumeHistory.shift();
  }

  if (!s.referencePrice) {
    s.referencePrice = currentPrice;
    log("INFO", coin.symbol, `Harga referensi awal: ${fPrice(currentPrice, coin)}`);
  }

  // Deteksi panic + aktifkan safe mode kalau perlu
  const panicData  = detectPanic(s.priceHistory, s.volumeHistory);
  const safeModeOn = checkAndActivateSafeMode(panicData, s.priceHistory);
  if (safeModeOn && !state[coin.symbol].buyPrice) {
    // Hanya skip beli saat safe mode, tetap pantau harga untuk sell
    if (s.cycleCount % 4 === 0) {
      log("WARN", coin.symbol, `⛔ Safe mode aktif (${safeModeReason}) — trading ditunda`);
    }
  }

  // Deteksi sinyal whale
  const whaleSignal = detectWhaleAccumulation(s.priceHistory, s.volumeHistory);
  const whaleTrap   = detectWhaleTrap(s.priceHistory);
  const isSideways  = isSidewaysMarket(s.priceHistory);

  // Analisis Claude — dipercepat saat Extreme Fear atau sedang holding
  const fgNow        = fearGreedData;
  const isExtremeFear = fgNow && fgNow.value <= 20;
  const fastInterval  = (s.buyPrice !== null) || isExtremeFear ? 4 : CONFIG.CLAUDE_ANALYSIS_INTERVAL;
  // 4 cycle × 30 detik = 2 menit saat extreme fear / holding
  // 16 cycle × 30 detik = 8 menit saat normal (hemat kredit)
  if (s.cycleCount % fastInterval === 1) {
    if (isExtremeFear && s.buyPrice === null) {
      log("AI", coin.symbol, `⚡ Extreme Fear (${fgNow.value}) — percepat analisis tiap 2 menit`);
    }
    await analyzeWithClaude(coin, ticker);
  }

  const strat          = s.strategy;
  const isHolding      = s.buyPrice !== null;
  const modalTerpakai  = s.totalIdrSpent;
  const modalTersisa   = CONFIG.TOTAL_MODAL_IDR - CONFIG.RESERVE_IDR - modalTerpakai;
  // All-in mode: tidak ada DCA (sudah beli semua sekaligus)
  const canDCA         = !CONFIG.ALL_IN_MODE
                         && isHolding
                         && s.orderCount < strat.maxOrders
                         && modalTersisa >= CONFIG.MAX_ORDER_IDR * 0.5;

  // Log sekali per 10 cycle kalau modal tidak cukup untuk DCA berikutnya
  if (!CONFIG.ALL_IN_MODE && isHolding && s.orderCount < strat.maxOrders && modalTersisa < CONFIG.MAX_ORDER_IDR * 0.5) {
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

  // C1-C4: analitik tambahan
  const regime     = detectMarketRegime(s.priceHistory);
  const srLevels   = calcSupportResistance(s.priceHistory);
  const volAnomaly = detectVolumeAnomaly(s.volumeHistory);
  const btcCorr    = calcBTCDOGECorrelation(s.priceHistory);

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
    candles:         getCandles(coin.symbol),
    regime,
    srLevels,
    volAnomaly,
    btcCorr,
    panicData,
    whaleSignal,
    whaleTrap,
    isSideways,
    safeModeActive:  safeModeOn,
    safeModeReason:  safeModeOn ? safeModeReason : null,
    cryptoPanic:     cryptoPanicData,
    googleTrends:    googleTrendsData,
    augmento:        augmentoData,
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

  // Log kondisi entry setiap 4 cycle (~2 menit) saat idle
  if (!isHolding && s.cycleCount % 4 === 0) {
    const rsiS = indicators
      ? (indicators.rsi < 35  ? `🟢OVERSOLD(${indicators.rsi.toFixed(0)})`
       : indicators.rsi > 65  ? `🔴OVERBOUGHT(${indicators.rsi.toFixed(0)})`
       : `🟡RSI(${indicators.rsi.toFixed(0)})`)
      : "RSI:N/A";
    const fgS  = fgNow
      ? (fgNow.value <= 20 ? `🟢EXTFEAR(${fgNow.value})`
       : fgNow.value >= 80 ? `🔴EXTGREED(${fgNow.value})`
       : `🟡FG(${fgNow.value})`)
      : "FG:N/A";
    const swS  = isSideways ? "🔴SIDEWAYS" : "✅OK";
    const sfS  = safeModeOn ? "🛡️SAFEMODE" : "✅OK";
    const gap  = buyTrigger > 0
      ? `gap:${((currentPrice - buyTrigger) / buyTrigger * 100).toFixed(2)}%`
      : "";
    log("INFO", coin.symbol,
      `Entry: ${rsiS} | ${fgS} | Market=${swS} | Safe=${sfS} | ${gap} | Claude=${strat.action}(${strat.confidence}%)`
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
    // Validasi profit bersih setelah fee (0.3% beli + 0.3% jual = 0.6% total)
    const FEE_TOTAL_PCT  = 0.6;
    const grossProfitPct = ((currentPrice - s.buyPrice) / s.buyPrice) * 100;
    const netProfitPct   = grossProfitPct - FEE_TOTAL_PCT;

    // Log warning kalau profit kecil tapi tetap jual — trigger sudah tercapai
    if (netProfitPct < 0.3) {
      log("WARN", coin.symbol,
        `Profit bersih kecil: ${netProfitPct.toFixed(2)}% setelah fee — tetap jual karena trigger tercapai`
      );
    }

    log("SELL", coin.symbol,
      `Target +${strat.SELL_RISE_PERCENT}% dari avg! Profit bersih: ~${netProfitPct.toFixed(2)}% | Jual posisi`
    );
    const ok = await placeSellOrder(coin, currentPrice, `Target +${strat.SELL_RISE_PERCENT}% (avg DCA)`);
    if (ok) s.referencePrice = currentPrice;
    return;
  }

  // ── 4B. JUAL SAAT RSI OVERBOUGHT + PROFIT ─────────────────
  if (isHolding && indicators && indicators.rsi !== null) {
    const isOverbought = indicators.rsi >= 70;
    const isProfit     = plPct !== null && plPct > 0;
    const netPL        = (plPct || 0) - 0.6;  // kurangi fee 0.6%

    if (isOverbought && isProfit && netPL > 0.5) {
      log("SELL", coin.symbol,
        `RSI overbought (${indicators.rsi.toFixed(1)}) + profit ${plPct.toFixed(2)}% → jual`
      );
      const ok = await placeSellOrder(coin, currentPrice,
        `RSI overbought ${indicators.rsi.toFixed(1)} + profit ${plPct.toFixed(2)}%`
      );
      if (ok) s.referencePrice = currentPrice;
      return;
    }
  }

  // Semua logic beli di bawah — skip jika cooldown aktif
  if (inCooldown) return;

  // Skip semua beli saat safe mode aktif
  if (safeModeOn) return;

  // Skip beli saat pasar sideways (terlalu maju/mundur tanpa arah)
  if (isSideways) {
    if (s.cycleCount % 8 === 0) {
      log("INFO", coin.symbol, "Pasar sideways — skip beli, tunggu breakout");
    }
    return;
  }

  // ── 5. AVERAGE DOWN — harga turun lagi dari avg ────────────
  if (canDCA && avgDownTrigger && currentPrice <= avgDownTrigger) {
    if (strat.sentiment === "BEARISH" && strat.confidence >= 80) {
      log("WARN", coin.symbol, `Average down skip — BEARISH ${strat.confidence}%`);
      return;
    }
    log("BUY", coin.symbol, `Average down! -${strat.BUY_DROP_PERCENT}% dari avg. Order #${s.orderCount + 1}/${strat.maxOrders}`);
    await placeBuyOrder(coin, currentPrice, strat.confidence);
    return;
  }

  // ── 6B. EXTREME FEAR OPPORTUNITY ─────────────────────────
  // Fear & Greed ≤ 15 = histori kuat untuk bounce 3-10%
  // Beli langsung tanpa tunggu trigger kalau semua konfirmasi
  if (!isHolding && !inCooldown && !safeModeOn
      && fgNow && fgNow.value <= 15
      && indicators && indicators.rsi !== null
      && indicators.rsi < 55
      && ticker.vol_coin > 0
      && strat.action === "BUY"
      && strat.confidence >= 70) {
    log("BUY", coin.symbol,
      `⚡ EXTREME FEAR BUY! F&G=${fgNow.value} + Claude BUY conf:${strat.confidence}% RSI:${indicators.rsi.toFixed(1)}`
    );
    const ok = await placeBuyOrder(coin, currentPrice, strat.confidence);
    if (ok) {
      s.referencePrice = currentPrice;
      log("INFO", coin.symbol, "Posisi dibuka saat Extreme Fear — target rebound 2-5%");
    }
    return;
  }

  // ── 6. CLAUDE BUY DENGAN MULTI-KONFIRMASI ─────────────────
  // Beli langsung hanya kalau semua kondisi terpenuhi:
  // 1. Claude sangat yakin (≥ 80%)
  // 2. RSI tidak overbought (< 60)
  // 3. Sentimen bukan BEARISH
  // 4. Volume ada
  // 5. Bukan sideways ekstrem
  if (!isHolding && !inCooldown && !safeModeOn
      && strat.action === "BUY"
      && strat.confidence >= 80
      && indicators && indicators.rsi !== null
      && indicators.rsi < 60
      && strat.sentiment !== "BEARISH"
      && ticker.vol_coin > 0
      && !isSidewaysMarket(s.priceHistory, 0.3)) {
    log("BUY", coin.symbol,
      `Claude BUY multi-konfirmasi (conf:${strat.confidence}% RSI:${indicators.rsi.toFixed(1)} ${strat.sentiment}) — beli langsung`
    );
    const ok = await placeBuyOrder(coin, currentPrice, strat.confidence);
    if (ok) s.referencePrice = currentPrice;
    return;
  }

  // Log penjelasan kenapa belum beli (tiap ~2 menit = 4 cycle × 30 detik)
  if (!isHolding && strat.action === "BUY" && currentPrice > buyTrigger) {
    if (s.cycleCount % 4 === 0) {
      const gap = ((currentPrice - buyTrigger) / buyTrigger * 100).toFixed(2);
      log("INFO", coin.symbol,
        `Claude BUY (conf: ${strat.confidence}%) — menunggu harga turun ${gap}% lagi ke ${fPrice(buyTrigger, coin)}`
      );
    }
  }

  // ── 7. HARGA TURUN KE TRIGGER (order pertama) ─────────────
  if (!isHolding && strat.action === "BUY" && currentPrice <= buyTrigger) {
    if (strat.sentiment === "BEARISH" && strat.confidence >= 80) {
      log("WARN", coin.symbol, `Sinyal beli ada tapi BEARISH ${strat.confidence}% — skip`);
      return;
    }
    log("BUY", coin.symbol, `Harga turun ${strat.BUY_DROP_PERCENT}% dari referensi — DCA Order #1`);
    const ok = await placeBuyOrder(coin, currentPrice, strat.confidence);
    if (ok) s.referencePrice = currentPrice;
  }
}

// ============================================================
// 🚀  MAIN LOOP
// ============================================================

// Bug #1: flag mencegah dua cycle berjalan bersamaan
let isProcessing = false;

// Interval dinamis: lebih cepat saat holding posisi
let dynamicCheckInterval = CONFIG.CHECK_INTERVAL_MS;

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
      [fearGreedData, coinGeckoData, cmcData, cryptoPanicData, googleTrendsData, augmentoData] = await Promise.all([
        fetchFearGreed(),
        fetchCoinGecko(),
        fetchCoinMarketCap(),
        fetchCryptoPanic(),
        fetchGoogleTrends(),
        fetchAugmento(),
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
      await fetchBTCPrice();
      // Broadcast sentimen ke dashboard
      if (cryptoPanicData) broadcast({ type: "cryptopanic",  data: cryptoPanicData  });
      if (googleTrendsData) broadcast({ type: "googletrends", data: googleTrendsData });
      if (augmentoData)     broadcast({ type: "augmento",     data: augmentoData     });
    }

    // Rebalance alokasi kapital setiap 120 cycle
    if (mainCycleCount % 120 === 0) {
      await rebalanceCapital();
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
      // B3: alert saldo IDR rendah (< 2× MAX_ORDER_IDR)
      if (idr < CONFIG.MAX_ORDER_IDR * 2) {
        const msg = `Saldo IDR rendah: Rp${Math.round(idr).toLocaleString("id-ID")} (threshold Rp${(CONFIG.MAX_ORDER_IDR * 2).toLocaleString("id-ID")})`;
        log("WARN", null, msg);
        broadcast({ type: "low_balance", idr, threshold: CONFIG.MAX_ORDER_IDR * 2, message: msg });
      }
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
  console.log(`  Analisis Claude: ~${(CONFIG.CLAUDE_ANALYSIS_INTERVAL * CONFIG.CHECK_INTERVAL_MS) / 60000} menit sekali (skip jika harga ±${CONFIG.CLAUDE_SKIP_THRESHOLD_PCT}%)`);
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

  // B1: tangkap error tak tertangani — broadcast ke dashboard
  process.on("uncaughtException", (err) => {
    const msg = `uncaughtException: ${err.message}`;
    log("ERROR", null, msg);
    broadcast({ type: "bot_error", message: msg, stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    const msg = `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`;
    log("ERROR", null, msg);
    broadcast({ type: "bot_error", message: msg });
  });
  process.on("SIGTERM", () => {
    log("WARN", null, "Bot dihentikan via SIGTERM");
    broadcast({ type: "bot_stopping", reason: "SIGTERM" });
    process.exit(0);
  });

  // B2: jadwalkan laporan harian pukul 22:00
  scheduleDailyReport();

  // Bug #1: gunakan setTimeout rekursif — cycle berikutnya dimulai
  // SETELAH cycle sekarang selesai, bukan bersamaan
  async function loop() {
    await runAll();
    // Saat holding, cek setiap 15 detik agar tidak melewatkan spike harga
    // Saat idle, cek setiap 30 detik (hemat API call)
    const isAnyHolding = COINS.some(c => state[c.symbol].buyPrice !== null);
    dynamicCheckInterval = isAnyHolding ? 15000 : CONFIG.CHECK_INTERVAL_MS;
    setTimeout(loop, dynamicCheckInterval);
  }
  loop();
}

main().catch(err => {
  log("ERROR", null, `Fatal: ${err.message}`);
  process.exit(1);
});
