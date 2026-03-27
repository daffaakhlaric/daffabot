/**
 * ============================================================
 *  MULTI-COIN BOT - INDODAX + CLAUDE AI + SENTIMENT ANALYSIS
 *  Data: Fear & Greed Index + CoinGecko + Indodax
 *  Otak: Claude AI → keputusan BUY / SELL / HOLD per koin
 * ============================================================
 *
 * SETUP:
 * 1. npm install axios crypto-js @anthropic-ai/sdk dotenv
 * 2. Isi file .env:
 *      INDODAX_API_KEY=...
 *      INDODAX_SECRET_KEY=...
 *      ANTHROPIC_API_KEY=...
 * 3. node indodax-bot.js
 */

require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");

// ============================================================
// ⚙️  KONFIGURASI
// ============================================================
const CONFIG = {
  API_KEY:    process.env.INDODAX_API_KEY    || "ISI_API_KEY_KAMU",
  SECRET_KEY: process.env.INDODAX_SECRET_KEY || "ISI_SECRET_KEY_KAMU",

  MAX_ORDER_IDR: 50000,       // Rp 50.000 per order per koin
  CHECK_INTERVAL_MS: 15000,   // Cek harga setiap 15 detik
  CLAUDE_ANALYSIS_INTERVAL: 8, // Analisis Claude tiap ~2 menit (8 × 15 detik)

  DRY_RUN: false,             // true = simulasi | false = trading sungguhan
};

// ============================================================
// 🪙  DAFTAR KOIN  (tambah/hapus sesuai kebutuhan)
// ============================================================
const COINS = [
  { symbol: "pepe", pair: "pepe_idr", coingeckoId: "pepe",      name: "PEPE", priceDecimals: 6 },
  { symbol: "doge", pair: "doge_idr", coingeckoId: "dogecoin",  name: "DOGE", priceDecimals: 0 },
  { symbol: "shib", pair: "shib_idr", coingeckoId: "shiba-inu", name: "SHIB", priceDecimals: 6 },
];

// ============================================================
const BASE_URL    = "https://indodax.com";
const claudeClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── State per koin ──────────────────────────────────────────
const state = {};
for (const coin of COINS) {
  state[coin.symbol] = {
    buyPrice:      null,
    coinHeld:      0,
    referencePrice: null,
    priceHistory:  [],
    cycleCount:    0,
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

// ── Cache data eksternal ─────────────────────────────────────
let fearGreedData  = null;
let coinGeckoData  = {};
let mainCycleCount = 0;

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
    ? `Holding ${fAmount(s.coinHeld, coin)}, dibeli @ ${fPrice(s.buyPrice, coin)} | P/L saat ini: ${(((ticker.last - s.buyPrice) / s.buyPrice) * 100).toFixed(2)}%`
    : `Tidak holding ${coin.name}`;

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

## Strategi Aktif
- Beli drop: -${s.strategy.BUY_DROP_PERCENT}% | Target jual: +${s.strategy.SELL_RISE_PERCENT}% | Stop loss: -${s.strategy.STOP_LOSS_PERCENT}%

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

  const amount   = Math.floor(idrToUse / price);
  const priceStr = coin.priceDecimals > 0 ? price.toFixed(coin.priceDecimals) : Math.round(price).toString();

  log("BUY", coin.symbol, `[${CONFIG.DRY_RUN ? "DRY" : "LIVE"}] BELI ${fAmount(amount, coin)} @ ${fPrice(price, coin)}`);

  if (CONFIG.DRY_RUN) {
    s.coinHeld = amount;
    s.buyPrice = price;
    log("INFO", coin.symbol, `Simulasi beli ${fAmount(amount, coin)} dengan Rp${idrToUse.toLocaleString("id-ID")}`);
    return true;
  }

  const result = await privateRequest("trade", {
    pair: coin.pair,
    type: "buy",
    price: priceStr,
    idr: Math.floor(idrToUse).toString(),
  });

  if (result) {
    s.buyPrice = price;
    log("BUY", coin.symbol, `Order berhasil! ID: ${result.order_id}`);
    return true;
  }
  return false;
}

async function placeSellOrder(coin, price, reason = "Target profit") {
  const s       = state[coin.symbol];
  const balance = await getBalance(coin);
  if (!balance) return false;

  const amount = CONFIG.DRY_RUN ? s.coinHeld : Math.floor(balance.coin);
  const minAmount = Math.max(1, Math.ceil(10000 / price)); // minimum Rp10.000
  if (amount < minAmount) {
    log("WARN", coin.symbol, `Saldo ${coin.name} tidak cukup: ${fAmount(amount, coin)}`);
    return false;
  }

  const priceStr = coin.priceDecimals > 0 ? price.toFixed(coin.priceDecimals) : Math.round(price).toString();
  const type     = reason.includes("Stop loss") ? "STOP" : "SELL";

  log(type, coin.symbol, `[${CONFIG.DRY_RUN ? "DRY" : "LIVE"}] ${reason} — JUAL ${fAmount(amount, coin)} @ ${fPrice(price, coin)}`);

  if (CONFIG.DRY_RUN) {
    const profit    = (price - s.buyPrice) * amount;
    const profitPct = ((price - s.buyPrice) / s.buyPrice) * 100;
    log("PROFIT", coin.symbol, `${profit >= 0 ? "Profit" : "Loss"}: Rp${profit.toLocaleString("id-ID")} (${profitPct.toFixed(2)}%)`);
    s.coinHeld = 0;
    s.buyPrice = null;
    return true;
  }

  const result = await privateRequest("trade", {
    pair:            coin.pair,
    type:            "sell",
    price:           priceStr,
    [coin.symbol]:   amount.toString(),
  });

  if (result) {
    s.buyPrice = null;
    log("SELL", coin.symbol, `Order berhasil! ID: ${result.order_id}`);
    return true;
  }
  return false;
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

  const strat          = s.strategy;
  const isHolding      = s.buyPrice !== null;
  const buyTrigger     = s.referencePrice * (1 - strat.BUY_DROP_PERCENT  / 100);
  const sellTrigger    = s.buyPrice ? s.buyPrice * (1 + strat.SELL_RISE_PERCENT / 100) : null;
  const stopLossTrigger = s.buyPrice ? s.buyPrice * (1 - strat.STOP_LOSS_PERCENT / 100) : null;
  const tag            = strat.lastUpdated ? `[${strat.action}/${strat.sentiment}]` : "[DEFAULT]";

  // Status log
  if (isHolding) {
    const plPct = ((currentPrice - s.buyPrice) / s.buyPrice) * 100;
    log("INFO", coin.symbol,
      `${fPrice(currentPrice, coin)} ${tag} | Holding | P/L: ${plPct.toFixed(2)}% | Target: ${fPrice(sellTrigger, coin)} | Stop: ${fPrice(stopLossTrigger, coin)}`
    );
  } else {
    log("INFO", coin.symbol,
      `${fPrice(currentPrice, coin)} ${tag} | Target beli: ${fPrice(buyTrigger, coin)} (-${strat.BUY_DROP_PERCENT}%)`
    );
  }

  // ── 1. STOP LOSS ──────────────────────────────────────────
  if (isHolding && stopLossTrigger && currentPrice <= stopLossTrigger) {
    log("STOP", coin.symbol, `Stop loss! ${fPrice(currentPrice, coin)} ≤ ${fPrice(stopLossTrigger, coin)}`);
    const ok = await placeSellOrder(coin, currentPrice, `Stop loss -${strat.STOP_LOSS_PERCENT}%`);
    if (ok) { s.referencePrice = currentPrice; s.cycleCount = 0; }
    return;
  }

  // ── 2. CLAUDE BILANG JUAL ─────────────────────────────────
  if (isHolding && strat.action === "SELL" && strat.confidence >= 60) {
    log("SELL", coin.symbol, `Claude rekomendasikan SELL (conf: ${strat.confidence}%)`);
    const ok = await placeSellOrder(coin, currentPrice, `Claude SELL signal`);
    if (ok) s.referencePrice = currentPrice;
    return;
  }

  // ── 3. TARGET PROFIT TERCAPAI ─────────────────────────────
  if (isHolding && sellTrigger && currentPrice >= sellTrigger) {
    const ok = await placeSellOrder(coin, currentPrice, `Target +${strat.SELL_RISE_PERCENT}%`);
    if (ok) s.referencePrice = currentPrice;
    return;
  }

  // ── 4. KONDISI BELI ───────────────────────────────────────
  if (!isHolding && strat.action !== "HOLD" && currentPrice <= buyTrigger) {
    if (strat.sentiment === "BEARISH" && strat.confidence >= 80) {
      log("WARN", coin.symbol, `Sinyal beli ada tapi BEARISH ${strat.confidence}% — skip`);
      return;
    }
    log("BUY", coin.symbol, `Harga turun ${strat.BUY_DROP_PERCENT}% dari referensi!`);
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
      const idr       = parseFloat(info.balance.idr || 0);
      const coinBals  = COINS.map(c => `${c.name}: ${Math.floor(info.balance[c.symbol] || 0).toLocaleString("id-ID")}`).join(" | ");
      log("INFO", null, `Saldo IDR : Rp${idr.toLocaleString("id-ID")}`);
      log("INFO", null, `Saldo koin: ${coinBals}`);
    }
  }

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
