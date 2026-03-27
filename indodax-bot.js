/**
 * ========================================
 *  BOT TRADING BTC/IDR - INDODAX
 *  Simple Buy Low, Sell High Bot
 * ========================================
 * 
 * CARA PAKAI:
 * 1. Install Node.js dari https://nodejs.org
 * 2. Install dependencies: npm install axios crypto-js
 * 3. Isi API_KEY dan SECRET_KEY di bawah
 * 4. Jalankan: node indodax-bot.js
 * 
 * ⚠️  PERINGATAN:
 * - Jangan share API Key ke siapapun
 * - Pastikan permission API hanya: Read Info + Trade
 * - Jangan aktifkan permission: Withdraw
 * - Mulai dengan modal kecil dulu!
 */

const axios = require("axios");
const crypto = require("crypto");

// =============================================
// ⚙️  KONFIGURASI - ISI BAGIAN INI
// =============================================
const CONFIG = {
  API_KEY: "ZGFERIYX-JURTJAU1-9AU73GHG-VAV6S9NR-RATG0XQT",
  SECRET_KEY: "898e1cebf5eb0f2fa4038ece2f0efd8cf87f13916dd0bfa4eda3230c4255f2c677fac7d104d2d0b4",

  // Strategi: Beli kalau harga turun X%, jual kalau naik Y%
  BUY_DROP_PERCENT: 2,      // Beli kalau harga turun 2% dari harga referensi
  SELL_RISE_PERCENT: 3,     // Jual kalau harga naik 3% dari harga beli

  // Modal maksimal per transaksi (dalam IDR)
  MAX_ORDER_IDR: 100000,    // Rp 100.000 per order

  // Interval cek harga (dalam milidetik)
  CHECK_INTERVAL_MS: 10000, // Cek setiap 10 detik

  // Mode dry run (true = simulasi saja, tidak eksekusi order sungguhan)
  DRY_RUN: false,            // ← Ganti ke FALSE kalau mau trading sungguhan!
};
// =============================================

const BASE_URL = "https://indodax.com";
let referencePrice = null;
let buyPrice = null;
let btcHeld = 0;
let startBalance = null;

// ── Logging ──────────────────────────────────
function log(type, msg) {
  const time = new Date().toLocaleTimeString("id-ID");
  const icons = { INFO: "ℹ️ ", BUY: "🟢", SELL: "🔴", WARN: "⚠️ ", ERROR: "❌", PROFIT: "💰" };
  console.log(`[${time}] ${icons[type] || "•"} ${msg}`);
}

// ── Buat signature HMAC-SHA512 ────────────────
function createSignature(body, secret) {
  return crypto.createHmac("sha512", secret).update(body).digest("hex");
}

// ── Harga BTC/IDR terkini ────────────────────
async function getCurrentPrice() {
  try {
    const res = await axios.get(`${BASE_URL}/api/btc_idr/ticker`);
    const { last, buy, sell } = res.data.ticker;
    return {
      last: parseFloat(last),
      buy: parseFloat(buy),
      sell: parseFloat(sell),
    };
  } catch (err) {
    log("ERROR", `Gagal ambil harga: ${err.message}`);
    return null;
  }
}

// ── Private API (perlu sign) ─────────────────
async function privateRequest(method, params = {}) {
  const nonce = Date.now().toString();
  const body = new URLSearchParams({ method, nonce, ...params }).toString();
  const sign = createSignature(body, CONFIG.SECRET_KEY);

  try {
    const res = await axios.post(`${BASE_URL}/tapi`, body, {
      headers: {
        "Key": CONFIG.API_KEY,
        "Sign": sign,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (res.data.success !== 1) {
      throw new Error(res.data.error || "API error");
    }
    return res.data.return;
  } catch (err) {
    log("ERROR", `API error (${method}): ${err.message}`);
    return null;
  }
}

// ── Cek saldo akun ───────────────────────────
async function getBalance() {
  const info = await privateRequest("getInfo");
  if (!info) return null;
  return {
    idr: parseFloat(info.balance.idr || 0),
    btc: parseFloat(info.balance.btc || 0),
  };
}

// ── Eksekusi order beli ──────────────────────
async function placeBuyOrder(price) {
  const balance = await getBalance();
  if (!balance) return false;

  const idrToUse = Math.min(balance.idr * 0.95, CONFIG.MAX_ORDER_IDR);
  if (idrToUse < 10000) {
    log("WARN", `Saldo IDR tidak cukup: Rp${balance.idr.toLocaleString("id-ID")}`);
    return false;
  }

  const btcAmount = (idrToUse / price).toFixed(8);
  log("BUY", `[${CONFIG.DRY_RUN ? "DRY RUN" : "REAL"}] Order BELI ${btcAmount} BTC @ Rp${price.toLocaleString("id-ID")}`);

  if (CONFIG.DRY_RUN) {
    btcHeld = parseFloat(btcAmount);
    buyPrice = price;
    log("INFO", `Simulasi: Beli ${btcAmount} BTC dengan Rp${idrToUse.toLocaleString("id-ID")}`);
    return true;
  }

  const result = await privateRequest("trade", {
    pair: "btc_idr",
    type: "buy",
    price: Math.floor(price).toString(),
    idr: Math.floor(idrToUse).toString(),
  });

  if (result) {
    buyPrice = price;
    log("BUY", `Order berhasil! Order ID: ${result.order_id}`);
    return true;
  }
  return false;
}

// ── Eksekusi order jual ──────────────────────
async function placeSellOrder(price) {
  const balance = await getBalance();
  if (!balance) return false;

  const btcToSell = CONFIG.DRY_RUN ? btcHeld : balance.btc;
  if (btcToSell < 0.00001) {
    log("WARN", `Saldo BTC tidak cukup: ${btcToSell} BTC`);
    return false;
  }

  const estimatedIDR = btcToSell * price;
  log("SELL", `[${CONFIG.DRY_RUN ? "DRY RUN" : "REAL"}] Order JUAL ${btcToSell} BTC @ Rp${price.toLocaleString("id-ID")}`);

  if (CONFIG.DRY_RUN) {
    const profit = (price - buyPrice) * btcToSell;
    log("PROFIT", `Profit: Rp${profit.toLocaleString("id-ID")} | Hasil: Rp${estimatedIDR.toLocaleString("id-ID")}`);
    btcHeld = 0;
    buyPrice = null;
    return true;
  }

  const result = await privateRequest("trade", {
    pair: "btc_idr",
    type: "sell",
    price: Math.floor(price).toString(),
    btc: btcToSell.toFixed(8),
  });

  if (result) {
    buyPrice = null;
    log("SELL", `Order berhasil! Order ID: ${result.order_id}`);
    return true;
  }
  return false;
}

// ── Logika utama bot ─────────────────────────
async function runBot() {
  const ticker = await getCurrentPrice();
  if (!ticker) return;

  const currentPrice = ticker.last;

  // Set harga referensi awal
  if (!referencePrice) {
    referencePrice = currentPrice;
    log("INFO", `Harga referensi awal: Rp${currentPrice.toLocaleString("id-ID")}`);
  }

  const buyTrigger = referencePrice * (1 - CONFIG.BUY_DROP_PERCENT / 100);
  const sellTrigger = buyPrice ? buyPrice * (1 + CONFIG.SELL_RISE_PERCENT / 100) : null;

  log("INFO", `Harga BTC: Rp${currentPrice.toLocaleString("id-ID")} | ${btcHeld > 0 ? `Holding ${btcHeld.toFixed(6)} BTC` : `Target beli: Rp${buyTrigger.toLocaleString("id-ID")}`}`);

  // Kondisi BELI
  if (btcHeld === 0 && !CONFIG.DRY_RUN === false ? true : btcHeld === 0) {
    if (currentPrice <= buyTrigger) {
      log("BUY", `Harga turun ${CONFIG.BUY_DROP_PERCENT}% dari referensi! Eksekusi beli...`);
      const success = await placeBuyOrder(currentPrice);
      if (success) referencePrice = currentPrice;
    }
  }

  // Kondisi JUAL
  if ((btcHeld > 0 || (!CONFIG.DRY_RUN)) && buyPrice && sellTrigger) {
    if (currentPrice >= sellTrigger) {
      log("SELL", `Harga naik ${CONFIG.SELL_RISE_PERCENT}% dari harga beli! Eksekusi jual...`);
      await placeSellOrder(currentPrice);
      referencePrice = currentPrice; // reset referensi
    }
  }
}

// ── Start ────────────────────────────────────
async function main() {
  console.log("=".repeat(50));
  console.log("  🤖 BOT TRADING BTC/IDR - INDODAX");
  console.log(`  Mode: ${CONFIG.DRY_RUN ? "🔵 DRY RUN (Simulasi)" : "🔴 LIVE TRADING"}`);
  console.log(`  Strategi: Beli -${CONFIG.BUY_DROP_PERCENT}% | Jual +${CONFIG.SELL_RISE_PERCENT}%`);
  console.log(`  Max order: Rp${CONFIG.MAX_ORDER_IDR.toLocaleString("id-ID")}`);
  console.log("=".repeat(50));

  if (CONFIG.API_KEY === "ISI_API_KEY_KAMU_DISINI") {
    log("WARN", "API Key belum diisi! Edit file dan isi CONFIG.API_KEY dan CONFIG.SECRET_KEY");
    log("INFO", "Menjalankan dalam mode simulasi harga real...");
  }

  // Cek koneksi & saldo
  if (CONFIG.API_KEY !== "ISI_API_KEY_KAMU_DISINI") {
    const balance = await getBalance();
    if (balance) {
      log("INFO", `Saldo: Rp${balance.idr.toLocaleString("id-ID")} | ${balance.btc} BTC`);
      startBalance = balance.idr;
    }
  }

  log("INFO", `Bot aktif! Cek harga setiap ${CONFIG.CHECK_INTERVAL_MS / 1000} detik...`);
  log("INFO", "Tekan Ctrl+C untuk hentikan bot");
  console.log("-".repeat(50));

  // Jalankan pertama kali
  await runBot();

  // Loop setiap interval
  setInterval(runBot, CONFIG.CHECK_INTERVAL_MS);
}

main().catch(err => {
  log("ERROR", `Fatal: ${err.message}`);
  process.exit(1);
});
