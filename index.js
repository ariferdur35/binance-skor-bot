/**
 * Binance Breakout Scanner — Telegram Bot
 *
 * Komutlar:
 *   /start  → Kaydol & yardım
 *   /stop   → Kaydı sil
 *   /15m    → 15 dakikalık tarama
 *   /1h     → 1 saatlik tarama
 *   /4h     → 4 saatlik tarama
 *   /1d     → Günlük tarama
 *
 * Kurulum:
 *   1. .env dosyasına TELEGRAM_BOT_TOKEN yaz
 *   2. npm install
 *   3. node index.js
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ─── Config ──────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const USERS_FILE = './chat-users.json';

if (!BOT_TOKEN) {
  console.error('❌ .env dosyasına TELEGRAM_BOT_TOKEN ekle!');
  process.exit(1);
}

// ─── Chat ID Yönetimi ─────────────────────────────────────────────────────────

function loadChatIds() {
  if (!existsSync(USERS_FILE)) return [];
  try { return JSON.parse(readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveChatIds(ids) {
  writeFileSync(USERS_FILE, JSON.stringify(ids, null, 2));
}

function addChatId(chatId) {
  const ids = loadChatIds();
  if (ids.includes(chatId)) return false;
  ids.push(chatId);
  saveChatIds(ids);
  return true;
}

function removeChatId(chatId) {
  const ids = loadChatIds();
  const idx = ids.indexOf(chatId);
  if (idx === -1) return false;
  ids.splice(idx, 1);
  saveChatIds(ids);
  return true;
}

function isAuthorized(chatId) {
  return loadChatIds().includes(chatId);
}

// ─── Tarama Ayarları ─────────────────────────────────────────────────────────
const MAX_SYMBOLS      = 250;
const MIN_24H_VOL_USDT = 250_000;
const PARALLEL         = 20;
const MIN_SCORE        = 6;

const MIN_RVOL       = 1.8;
const BB_SQUEEZE_PCT = 0.03;
const RSI_MIN        = 45;
const RSI_MAX        = 70;
const RANGE_SQUEEZE  = 0.40;
const MAX_PUMP_PCT   = 20;
const MAX_SMA_DIST   = 0.15;
const RVOL_LAG_BARS  = 5;

const TF_MAP = {
  '/15m': { interval: '15m', label: '15 Dakika', htfGroup: 16 },
  '/1h':  { interval: '1h',  label: '1 Saat',    htfGroup: 4  },
  '/4h':  { interval: '4h',  label: '4 Saat',    htfGroup: 6  },
  '/1d':  { interval: '1d',  label: 'Günlük',    htfGroup: 5  },
};

const STABLECOINS = new Set([
  'USDC','BUSD','DAI','TUSD','USDP','USDD','FDUSD','PYUSD','AEUR',
  'EURC','EURI','EURS','SEUR','BIDR','IDRT','BVND','BKRW','VAI',
  'USTC','UST','USDJ','USDX','USDK','SUSD','GUSD','HUSD','OUSD',
  'FRAX','LUSD','DOLA','CRVUSD','GYEN','PAXG','XAUT',
  'USD1','USDE','USDT0','USDTB','XUSD','ZUSD','CUSD','MUSD',
  'EUR','GBP','AUD','TRY','BRL','RUB','NGN','ZAR','PLN','RON','BFUSD',
]);

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Telegram API ─────────────────────────────────────────────────────────────

async function tgSend(chatId, text, extra = {}) {
  await fetch(`${TG_API}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
  });
}

async function tgSetTyping(chatId) {
  await fetch(`${TG_API}/sendChatAction`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});
}

async function getUpdates(offset) {
  const res  = await fetch(`${TG_API}/getUpdates?timeout=30&offset=${offset}`);
  const data = await res.json();
  return data.ok ? data.result : [];
}

// ─── Binance API ─────────────────────────────────────────────────────────────

async function fetchBinanceTickers() {
  const res  = await fetch('https://api.binance.com/api/v3/ticker/24hr');
  const data = await res.json();
  return data.filter(t => t.symbol.endsWith('USDT'));
}

async function fetchExchangeInfo() {
  const res  = await fetch('https://api.binance.com/api/v3/exchangeInfo');
  const data = await res.json();
  const map  = {};
  for (const s of data.symbols) map[s.symbol] = s.status;
  return map;
}

async function fetchMonitoringList() {
  try {
    const res  = await fetch(
      'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await res.json();
    const set  = new Set();
    for (const p of (data?.data || [])) {
      const tags = p.tags || [];
      if (tags.some(t => /monitor|delist|caution/i.test(t)) ||
          (p.st || '').toLowerCase() === 'delisting') set.add(p.s);
    }
    return set;
  } catch { return new Set(); }
}

async function fetchKlines(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.map(k => ({
    time:   k[0] / 1000,
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

async function fetchAllKlines(symbols, interval, limit) {
  const results = {};
  for (let i = 0; i < symbols.length; i += PARALLEL) {
    const chunk   = symbols.slice(i, i + PARALLEL);
    const settled = await Promise.allSettled(
      chunk.map(s => fetchKlines(s, interval, limit).then(bars => ({ s, bars })))
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') results[r.value.s] = r.value.bars;
    }
    if (i + PARALLEL < symbols.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

async function buildSymbolList() {
  const [tickers, statusMap, monitoring] = await Promise.all([
    fetchBinanceTickers(),
    fetchExchangeInfo(),
    fetchMonitoringList(),
  ]);
  const filtered = tickers.filter(t => {
    const base = t.symbol.replace('USDT', '');
    if (STABLECOINS.has(base))                         return false;
    if (statusMap[t.symbol] !== 'TRADING')             return false;
    if (monitoring.has(t.symbol))                      return false;
    if (parseFloat(t.quoteVolume) < MIN_24H_VOL_USDT) return false;
    return true;
  });
  filtered.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
  return filtered.slice(0, MAX_SYMBOLS).map(t => ({
    symbol:  t.symbol,
    vol24hM: Math.round(parseFloat(t.quoteVolume) / 1_000_000),
    price:   parseFloat(t.lastPrice),
  }));
}

// ─── Teknik Hesaplamalar ─────────────────────────────────────────────────────

function aggregateBars(bars, groupSize) {
  const result = [];
  for (let i = 0; i + groupSize <= bars.length; i += groupSize) {
    const g = bars.slice(i, i + groupSize);
    result.push({
      open:   g[0].open,
      high:   Math.max(...g.map(b => b.high)),
      low:    Math.min(...g.map(b => b.low)),
      close:  g[g.length - 1].close,
      volume: g.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

function calcHTFema(bars, groupSize, period = 20) {
  const htf = aggregateBars(bars, groupSize);
  if (htf.length < period) return null;
  const closes = htf.map(b => b.close);
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return { above: bars[bars.length - 1].close > ema };
}

function calcWick(bars) {
  const b = bars[bars.length - 1];
  const range = b.high - b.low;
  if (range === 0) return null;
  const bodyTop = Math.max(b.open, b.close);
  const bodyBot = Math.min(b.open, b.close);
  const upper   = (b.high - bodyTop) / range;
  const lower   = (bodyBot - b.low)  / range;
  let signal = 'neutral';
  if (lower >= 0.40 && lower > upper * 1.5) signal = 'bullish';
  if (upper >= 0.40 && upper > lower * 1.5) signal = 'bearish';
  return { signal, upper: +upper.toFixed(2), lower: +lower.toFixed(2) };
}

function calcRVOL(bars) {
  if (bars.length < 21) return null;
  const recent = bars[bars.length - 1].volume;
  const avg    = bars.slice(-21, -1).reduce((s, b) => s + b.volume, 0) / 20;
  return avg > 0 ? recent / avg : null;
}

function calcBBWidth(bars, period = 20) {
  if (bars.length < period) return null;
  const closes = bars.slice(-period).map(b => b.close);
  const mean   = closes.reduce((s, v) => s + v, 0) / period;
  const std    = Math.sqrt(closes.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  const price  = bars[bars.length - 1].close;
  return price > 0 ? (std * 4) / price : null;
}

function calcRSI(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const slice = bars.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i].close - slice[i - 1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function calcRangeSqueeze(bars) {
  if (bars.length < 25) return null;
  const avg20 = bars.slice(-20).map(b => b.high - b.low).reduce((s, v) => s + v, 0) / 20;
  const avg5  = bars.slice(-5).map(b => b.high - b.low).reduce((s, v) => s + v, 0) / 5;
  return avg20 > 0 ? avg5 / avg20 : null;
}

function calcMomentum(bars) {
  if (bars.length < 4) return null;
  const last = bars.slice(-3).map(b => b.close);
  return last[2] > last[0] ? 'up' : last[2] < last[0] ? 'down' : 'flat';
}

function calcPumpStatus(bars) {
  const lookback = 20;
  const past     = bars.length > lookback ? bars[bars.length - 1 - lookback].close : null;
  const current  = bars[bars.length - 1].close;
  const pumpPct  = past && past > 0 ? ((current - past) / past) * 100 : null;

  const closes   = bars.slice(-20).map(b => b.close);
  const sma      = closes.reduce((s, v) => s + v, 0) / closes.length;
  const smaDist  = sma > 0 ? (current - sma) / sma : null;

  const vols     = bars.slice(-10).map(b => b.volume);
  const maxIdx   = vols.lastIndexOf(Math.max(...vols));
  const rvolLag  = 9 - maxIdx;

  const alreadyPumped =
    (pumpPct != null && pumpPct > MAX_PUMP_PCT) ||
    (smaDist != null && smaDist > MAX_SMA_DIST) ||
    (rvolLag != null && rvolLag > RVOL_LAG_BARS);

  return { alreadyPumped, pumpPct: pumpPct != null ? +pumpPct.toFixed(1) : null };
}

function calcScore(r) {
  if (r.alreadyPumped) return 0;
  let s = 0;
  if ((r.rvol ?? 0) >= MIN_RVOL)             s += 3;
  if (r.bbSqueeze)                            s += 2;
  if (r.rangeSqueeze)                         s += 2;
  if (r.rsi >= RSI_MIN && r.rsi <= RSI_MAX)  s += 1;
  if (r.momentum === 'up')                    s += 1;
  if (r.htfAbove === true)                    s += 1;
  if (r.wickSignal === 'bullish')             s += 1;
  if (r.wickSignal === 'bearish')             s -= 1;
  return Math.max(s, 0);
}

// ─── Tarama ──────────────────────────────────────────────────────────────────

async function runScan(interval, htfGroup) {
  const BARS = interval === '15m' ? 400 : 200;

  const symbolList = await buildSymbolList();
  const symbols    = symbolList.map(s => s.symbol);
  const klineMap   = await fetchAllKlines(symbols, interval, BARS);

  const results = [];
  for (const item of symbolList) {
    const bars = klineMap[item.symbol];
    if (!bars || bars.length < 30) continue;

    const rvol       = calcRVOL(bars);
    const bbWidth    = calcBBWidth(bars);
    const rsi        = calcRSI(bars);
    const rangeRatio = calcRangeSqueeze(bars);
    const momentum   = calcMomentum(bars);
    const htf        = calcHTFema(bars, htfGroup, 20);
    const wick       = calcWick(bars);
    const pump       = calcPumpStatus(bars);
    const price      = bars[bars.length - 1].close;
    const change     = bars.length >= 5
      ? +((price - bars[bars.length - 5].close) / bars[bars.length - 5].close * 100).toFixed(2)
      : null;

    const entry = {
      symbol:        item.symbol,
      price,
      vol24hM:       item.vol24hM,
      change,
      rvol:          rvol        != null ? +rvol.toFixed(2) : null,
      rsi:           rsi         != null ? +rsi.toFixed(1)  : null,
      momentum,
      htfAbove:      htf?.above  ?? null,
      wickSignal:    wick?.signal ?? null,
      alreadyPumped: pump.alreadyPumped,
      pumpPct:       pump.pumpPct,
      bbSqueeze:     bbWidth    != null && bbWidth < BB_SQUEEZE_PCT,
      rangeSqueeze:  (rangeRatio != null) && rangeRatio < RANGE_SQUEEZE,
    };
    entry.score = calcScore(entry);
    results.push(entry);
  }

  results.sort((a, b) => b.score - a.score || (b.rvol ?? 0) - (a.rvol ?? 0));
  return { results, total: symbolList.length };
}

// ─── Telegram Mesaj Formatı ───────────────────────────────────────────────────

function formatCoin(r, rank) {
  const dir    = r.change > 0 ? '📈' : r.change < 0 ? '📉' : '➡️';
  const chgStr = r.change != null ? `${r.change > 0 ? '+' : ''}${r.change}%` : '-';

  const badges = [
    r.bbSqueeze                ? '⚡Squeeze'      : '',
    r.rangeSqueeze             ? '📦Dar-Range'     : '',
    r.htfAbove === true        ? '✅HTF-Üstü'      : r.htfAbove === false ? '❌HTF-Altı' : '',
    r.wickSignal === 'bullish' ? '🟢Alıcı-Wick'   : '',
    r.wickSignal === 'bearish' ? '🔴Tuzak-Wick'   : '',
  ].filter(Boolean).join(' ');

  return (
    `${rank}. <b>${r.symbol}</b>  $${r.price}\n` +
    `   🏆 Skor: <b>${r.score}/11</b>  ${dir} ${chgStr}\n` +
    `   📊 RVOL: ${r.rvol ?? '-'}x  RSI: ${r.rsi ?? '-'}\n` +
    `   💰 Vol: ${r.vol24hM}M$\n` +
    (badges ? `   ${badges}\n` : '')
  );
}

function formatResults(results, label, elapsed, total) {
  const candidates = results.filter(r => r.score >= MIN_SCORE);

  if (candidates.length === 0) {
    return (
      `🔍 <b>Binance ${label} Tarama Tamamlandı</b>\n` +
      `⏱ ${elapsed}s  |  ${total} coin\n\n` +
      `😴 Şu an skor ≥ ${MIN_SCORE} aday yok. Piyasa sakin.`
    );
  }

  let msg =
    `🚀 <b>Binance ${label} — Breakout Adayları</b>\n` +
    `⏱ ${elapsed}s  |  ${total} coin tarandı  |  ${candidates.length} aday\n` +
    `─────────────────────\n\n`;

  candidates.forEach((r, i) => {
    msg += formatCoin(r, i + 1) + '\n';
  });

  msg += `─────────────────────\n`;
  msg += `<i>Skor ≥ ${MIN_SCORE} olanlar gösterildi (max 11)</i>`;
  return msg;
}

// ─── Komut İşleyici ──────────────────────────────────────────────────────────

const HELP_TEXT =
  `🤖 <b>Binance Breakout Scanner Bot</b>\n\n` +
  `Komutlar:\n` +
  `  <code>/15m</code>  → 15 dakikalık tarama\n` +
  `  <code>/1h</code>   → 1 saatlik tarama\n` +
  `  <code>/4h</code>   → 4 saatlik tarama\n` +
  `  <code>/1d</code>   → Günlük tarama\n` +
  `  <code>/stop</code> → Botu durdur & kaydı sil\n\n` +
  `Sadece skor ≥ ${MIN_SCORE} olan coinler gönderilir.\n` +
  `Tarama ~15 saniye sürer.`;

const activeScans = new Set();

async function handleMessage(chatId, text) {
  const cmd = text.trim().split(' ')[0].split('@')[0].toLowerCase();

  // /start → Chat ID kaydet
  if (cmd === '/start') {
    const isNew = addChatId(chatId);
    if (isNew) {
      console.log(`✅ Yeni kullanıcı: ${chatId}`);
      await tgSend(chatId,
        `✅ <b>Kayıt başarılı!</b>\n` +
        `Chat ID'n: <code>${chatId}</code> kaydedildi.\n\n` +
        HELP_TEXT
      );
    } else {
      await tgSend(chatId,
        `ℹ️ Zaten kayıtlısın.\n` +
        `Chat ID: <code>${chatId}</code>\n\n` +
        HELP_TEXT
      );
    }
    return;
  }

  // /stop → Chat ID sil
  if (cmd === '/stop') {
    const removed = removeChatId(chatId);
    if (removed) {
      console.log(`🗑️ Kullanıcı silindi: ${chatId}`);
      await tgSend(chatId,
        `🗑️ <b>Kaydın silindi.</b>\n` +
        `Artık tarama sonuçları gelmeyecek.\n` +
        `Tekrar başlamak için /start yaz.`
      );
    } else {
      await tgSend(chatId, `ℹ️ Zaten kayıtlı değilsin. Başlamak için /start yaz.`);
    }
    return;
  }

  // Yetki kontrolü
  if (!isAuthorized(chatId)) {
    await tgSend(chatId, `⛔ Kayıtlı değilsin.\nBaşlamak için /start yaz.`);
    return;
  }

  if (cmd === '/help' || cmd === 'yardim') {
    await tgSend(chatId, HELP_TEXT);
    return;
  }

  const tf = TF_MAP[cmd];
  if (!tf) return;

  if (activeScans.has(chatId)) {
    await tgSend(chatId, '⏳ Zaten bir tarama devam ediyor, lütfen bekle...');
    return;
  }

  activeScans.add(chatId);
  await tgSend(chatId, `🔍 <b>${tf.label}</b> taraması başladı...\n⏳ ~15 saniye sürer.`);
  await tgSetTyping(chatId);

  try {
    const t0 = Date.now();
    console.log('📡 Coin listesi çekiliyor...');
    const { results, total } = await runScan(tf.interval, tf.htfGroup);
    console.log(`✅ Tarama bitti: ${total} coin, ${results.length} sonuç`);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const msg     = formatResults(results, tf.label, elapsed, total);
    console.log(`📨 Mesaj gönderiliyor... (${msg.length} karakter)`);

    if (msg.length <= 4096) {
      await tgSend(chatId, msg);
    } else {
      const candidates = results.filter(r => r.score >= MIN_SCORE);
      await tgSend(chatId, `🚀 <b>Binance ${tf.label} — ${candidates.length} Aday</b> (${elapsed}s)\n\n`);
      for (let i = 0; i < candidates.length; i++) {
        await tgSend(chatId, formatCoin(candidates[i], i + 1));
        await new Promise(r => setTimeout(r, 100));
      }
    }
  } catch (err) {
    await tgSend(chatId, `❌ Tarama hatası: ${err.message}`);
    console.error('Scan error:', err);
  } finally {
    activeScans.delete(chatId);
  }
}

// ─── Bot Başlat ───────────────────────────────────────────────────────────────

async function startBot() {
  console.log('🤖 Binance Scanner Bot başlatıldı...');

  const meRes  = await fetch(`${TG_API}/getMe`);
  const meData = await meRes.json();
  if (!meData.ok) {
    console.error('❌ Bot token geçersiz:', meData.description);
    process.exit(1);
  }
  console.log(`✅ Bot: @${meData.result.username}`);
  console.log(`📨 Komutlar: /15m  /1h  /4h  /1d  /stop\n`);

  let offset = 0;

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg    = update.message || update.channel_post;
        if (!msg?.text) continue;
        const chatId = String(msg.chat.id);
        const user   = msg.from?.username ? `@${msg.from.username}` : chatId;
        console.log(`[${new Date().toLocaleTimeString()}] ${user}: "${msg.text}"`);
        handleMessage(chatId, msg.text).catch(console.error);
      }
    } catch (err) {
      console.error('Polling hatası:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

startBot();
