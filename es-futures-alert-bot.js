#!/usr/bin/env node
/**
 * es-futures-alert-bot.js  (v2 — free polling, no TradingView needed)
 * Polls the /ES price (Yahoo Finance, free, no key) and RE-SENDS a Telegram
 * alert every ~25s until you reply /stop. The TradingView webhook still works
 * too, in case you ever upgrade.
 *
 * Control it entirely from Telegram:
 *   /watch 7400 below   -> alert when ES drops to/below 7400
 *   /watch 7600 above   -> alert when ES rises to/above 7600
 *   /list               -> show active watches
 *   /clear              -> remove all watches
 *   /price              -> current ES price
 *   /status             -> is an alert ringing right now?
 *   /stop               -> silence the ringing alert
 *   /help               -> show this list
 *
 * Node 18+. Zero dependencies.
 */

const http = require('http');

const CONFIG = {
  BOT_TOKEN:   process.env.TELEGRAM_BOT_TOKEN || 'PASTE_BOT_TOKEN_HERE',
  CHAT_ID:     process.env.TELEGRAM_CHAT_ID   || 'PASTE_CHAT_ID_HERE',
  SECRET:      process.env.WEBHOOK_SECRET     || 'change-this-secret',
  PORT:        Number(process.env.PORT || 8080),
  REPEAT_MS:   Number(process.env.REPEAT_INTERVAL_MS || 25000),
  MAX_REPEATS: Number(process.env.MAX_REPEATS || 40),
  POLL_MS:     Number(process.env.POLL_MS || 30000), // how often to check price
  SYMBOL:      process.env.SYMBOL || 'ES=F',         // /ES front-month on Yahoo
};

const TG = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}`;
let active = null;     // the currently-ringing alert
let watches = [];      // [{ level, dir }]  (note: cleared if the bot redeploys)
let lastPrice = null;

async function tgSend(text) {
  try {
    await fetch(`${TG}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.CHAT_ID, text }),
    });
  } catch (e) { console.error('tgSend:', e.message); }
}

function startRepeating(message) {
  stopRepeating(false);
  active = { text: message, count: 0, timer: null };
  const fire = async () => {
    active.count++;
    await tgSend(`🚨 ${message}\n\n🔁 ${active.count}/${CONFIG.MAX_REPEATS} — reply /stop to silence`);
    if (active.count >= CONFIG.MAX_REPEATS) stopRepeating(true);
  };
  fire();
  active.timer = setInterval(fire, CONFIG.REPEAT_MS);
}
function stopRepeating(notify) {
  const had = !!active;
  if (active && active.timer) clearInterval(active.timer);
  active = null;
  if (notify && had) tgSend('✅ Alert silenced.');
}

// --- free price source: Yahoo Finance chart endpoint (no API key) ---
async function fetchPrice() {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const h of hosts) {
    try {
      const r = await fetch(
        `https://${h}/v8/finance/chart/${encodeURIComponent(CONFIG.SYMBOL)}?interval=1m&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const j = await r.json();
      const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof p === 'number') return p;
    } catch (_) { /* try next host */ }
  }
  return null;
}

async function poll() {
  const price = await fetchPrice();
  if (price != null) {
    lastPrice = price;
    const triggered = [];
    watches = watches.filter(w => {
      const hit = (w.dir === 'above' && price >= w.level) || (w.dir === 'below' && price <= w.level);
      if (hit) triggered.push(w);
      return !hit; // one-shot: drop a watch once it fires
    });
    if (triggered.length) {
      const w = triggered[0];
      startRepeating(`ES ${w.dir} ${w.level} — now ${price}`);
    }
  }
  setTimeout(poll, CONFIG.POLL_MS);
}
poll();

// --- HTTP webhook (still here for TradingView, if you ever upgrade) ---
http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    let secret = url.searchParams.get('secret'), text = body;
    try { const j = JSON.parse(body); if (j.secret) secret = j.secret; if (j.message) text = j.message; } catch (_) {}
    if (secret !== CONFIG.SECRET) { res.writeHead(401); return res.end('bad secret'); }
    startRepeating((text || 'TradingView alert').trim());
    res.writeHead(200); res.end('ok');
  });
}).listen(CONFIG.PORT, () => console.log(`Webhook on :${CONFIG.PORT}`));

// --- Telegram command listener ---
let offset = 0;
async function pollTelegram() {
  try {
    const r = await fetch(`${TG}/getUpdates?timeout=30&offset=${offset}`);
    const data = await r.json();
    if (data.ok) for (const u of data.result) {
      offset = u.update_id + 1;
      const m = u.message; if (!m || !m.text) continue;
      if (String(m.chat.id) !== String(CONFIG.CHAT_ID)) continue;
      handleCommand(m.text.trim());
    }
  } catch (e) { console.error('tg poll:', e.message); }
  setTimeout(pollTelegram, 500);
}
pollTelegram();

function handleCommand(raw) {
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/stop' || cmd === 'stop') return stopRepeating(true);

  if (cmd === '/status')
    return tgSend(active ? `🔔 Ringing: ${active.text} (${active.count}/${CONFIG.MAX_REPEATS})` : '😴 No active alert.');

  if (cmd === '/price')
    return tgSend(lastPrice != null ? `ES (${CONFIG.SYMBOL}) ≈ ${lastPrice}` : 'No price yet — give it a few seconds.');

  if (cmd === '/list') {
    if (!watches.length) return tgSend('No watches set. Add one:  /watch 7400 below');
    return tgSend('👀 Watches:\n' + watches.map(w => `• ES ${w.dir} ${w.level}`).join('\n'));
  }

  if (cmd === '/clear') { watches = []; return tgSend('🧹 All watches cleared.'); }

  if (cmd === '/watch') {
    const level = parseFloat(parts[1]);
    const dir = (parts[2] || '').toLowerCase();
    if (isNaN(level) || (dir !== 'above' && dir !== 'below'))
      return tgSend('Usage:  /watch <price> <above|below>\ne.g.  /watch 7400 below');
    watches.push({ level, dir });
    let note = `✅ Watching: ES ${dir} ${level}.`;
    if (lastPrice != null) {
      const already = (dir === 'above' && lastPrice >= level) || (dir === 'below' && lastPrice <= level);
      note += already ? `\n⚠️ Price is already ${lastPrice} — this fires on the next check.` : `\n(now ${lastPrice})`;
    }
    return tgSend(note);
  }

  if (cmd === '/start' || cmd === '/help')
    return tgSend('Commands:\n/watch 7400 below\n/watch 7600 above\n/list\n/clear\n/price\n/status\n/stop');
}
