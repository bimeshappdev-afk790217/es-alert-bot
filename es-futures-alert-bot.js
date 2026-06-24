#!/usr/bin/env node
/**
 * es-futures-alert-bot.js
 * TradingView webhook  ->  Telegram, RE-SENDS every ~25s until you reply /stop.
 * Each resend = a fresh push = your phone announces it again (loop-until-stopped).
 *
 * Node 18+ (uses built-in fetch). Zero dependencies.
 *
 * ----------------------------------------------------------------------------
 * SETUP (5 min):
 *  1. In Telegram, message @BotFather -> /newbot -> copy the BOT TOKEN.
 *  2. Message your new bot once ("hi"), then message @userinfobot to get your CHAT ID
 *     (or run the bot and check the console — it logs the chat id of anyone who messages it).
 *  3. Set env vars (or paste below) and run:  node es-futures-alert-bot.js
 *  4. Host it on an always-on box so it's reliable (Railway / Render / Fly.io / cheap VPS).
 *     For a quick test from your laptop, expose it with:  cloudflared tunnel --url http://localhost:8080
 *  5. In TradingView (paid plan required for webhooks): create an alert on ES1! (or MES1!),
 *     open the "Notifications" tab -> tick "Webhook URL" -> paste:
 *        https://YOUR-HOST/?secret=YOUR_SECRET
 *     In the alert "Message" box, write what you want spoken, e.g.:
 *        ES crossed {{close}} — {{ticker}} alert
 * ----------------------------------------------------------------------------
 */

const http = require('http');

const CONFIG = {
  BOT_TOKEN:  process.env.TELEGRAM_BOT_TOKEN || 'PASTE_BOT_TOKEN_HERE',
  CHAT_ID:    process.env.TELEGRAM_CHAT_ID   || 'PASTE_CHAT_ID_HERE',
  SECRET:     process.env.WEBHOOK_SECRET     || 'change-this-secret',
  PORT:       Number(process.env.PORT || 8080),
  REPEAT_MS:  Number(process.env.REPEAT_INTERVAL_MS || 25000), // resend cadence
  MAX_REPEATS:Number(process.env.MAX_REPEATS || 40),           // safety cap (~16 min @ 25s)
};

const TG = `https://api.telegram.org/bot${CONFIG.BOT_TOKEN}`;
let active = null; // { text, count, timer }

async function tgSend(text) {
  try {
    await fetch(`${TG}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CONFIG.CHAT_ID, text }),
    });
  } catch (e) { console.error('tgSend error:', e.message); }
}

function startRepeating(message) {
  stopRepeating(false); // replace any current alert
  active = { text: message, count: 0, timer: null };
  const fire = async () => {
    active.count++;
    await tgSend(`🚨 ${message}\n\n🔁 ${active.count}/${CONFIG.MAX_REPEATS} — reply /stop to silence`);
    if (active.count >= CONFIG.MAX_REPEATS) stopRepeating(true);
  };
  fire();                                   // immediate first alert
  active.timer = setInterval(fire, CONFIG.REPEAT_MS);
}

function stopRepeating(notify) {
  const had = !!active;
  if (active && active.timer) clearInterval(active.timer);
  active = null;
  if (notify && had) tgSend('✅ Alert silenced.');
}

// --- HTTP server: receives the TradingView webhook POST ---
http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    let secret = url.searchParams.get('secret');
    let text = body;
    try { const j = JSON.parse(body); if (j.secret) secret = j.secret; if (j.message) text = j.message; }
    catch (_) { /* plain-text body is fine */ }

    if (secret !== CONFIG.SECRET) { res.writeHead(401); return res.end('bad secret'); }
    startRepeating((text || 'TradingView alert').trim());
    res.writeHead(200); res.end('ok');
  });
}).listen(CONFIG.PORT, () => console.log(`Webhook listening on :${CONFIG.PORT}  (POST /?secret=...)`));

// --- Telegram long-poll: listen for /stop and /status ---
let offset = 0;
async function poll() {
  try {
    const r = await fetch(`${TG}/getUpdates?timeout=30&offset=${offset}`);
    const data = await r.json();
    if (data.ok) for (const u of data.result) {
      offset = u.update_id + 1;
      const m = u.message; if (!m || !m.text) continue;
      console.log('msg from chat id:', m.chat.id, '->', m.text); // helps you grab your CHAT_ID
      if (String(m.chat.id) !== String(CONFIG.CHAT_ID)) continue;
      const t = m.text.trim().toLowerCase();
      if (t === '/stop' || t === 'stop') stopRepeating(true);
      else if (t === '/status') tgSend(active
        ? `🔔 Active: ${active.text} (${active.count}/${CONFIG.MAX_REPEATS})`
        : '😴 No active alert.');
    }
  } catch (e) { console.error('poll error:', e.message); }
  setTimeout(poll, 500);
}
poll();
