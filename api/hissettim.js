const reports = new Map(); // il -> [{ip, ts}]
const cooldowns = new Map(); // ip+il -> ts
const notified = new Map(); // il -> ts (son bildirim zamanı)

const THRESHOLD = parseInt(process.env.HISSET_THRESHOLD || '5');
const WINDOW_MS = 10 * 1000;      // 10 saniye
const COOLDOWN_MS = 30 * 1000;    // aynı kullanıcı 30 sn beklesin
const NOTIF_COOLDOWN_MS = 60 * 1000; // aynı il için 60 sn içinde tekrar bildirim gitmesin

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const { il } = body || {};
  if (!il) return res.status(400).json({ error: 'il eksik' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const ckKey = ip + '|' + il;

  // Aynı kullanıcı cooldown kontrolü
  if (cooldowns.has(ckKey) && now - cooldowns.get(ckKey) < COOLDOWN_MS) {
    return res.status(200).json({ status: 'cooldown', message: 'Kısa süre önce bildirdin.' });
  }
  cooldowns.set(ckKey, now);

  // Rapor listesini güncelle — eski kayıtları temizle
  const list = (reports.get(il) || []).filter(r => now - r.ts < WINDOW_MS);
  // Aynı IP'yi tekrar ekleme
  if (!list.find(r => r.ip === ip)) list.push({ ip, ts: now });
  reports.set(il, list);

  const count = list.length;

  // Eşik kontrolü
  if (count >= THRESHOLD) {
    const lastNotif = notified.get(il) || 0;
    if (now - lastNotif > NOTIF_COOLDOWN_MS) {
      notified.set(il, now);
      reports.set(il, []); // sayacı sıfırla

      // OneSignal bildirimi gönder
      const apiKey = process.env.ONESIGNAL_API_KEY;
      const appId  = process.env.ONESIGNAL_APP_ID;
      if (apiKey && appId) {
        const title   = 'Sarsıntı Hissiyatı';
        const message = il + ' bölgesindeki kullanıcılar sarsıntı hissettiğini bildiriyor.';
        await fetch('https://api.onesignal.com/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Key ${apiKey}` },
          body: JSON.stringify({
            app_id: appId,
            included_segments: ['Total Subscriptions'],
            headings: { tr: title, en: title },
            contents: { tr: message, en: message },
            chrome_web_icon: 'https://tdb-source.vercel.app/icons/icon-192.png',
            url: 'https://tdb-source.vercel.app/bildirim.html?title=' + encodeURIComponent(title) + '&msg=' + encodeURIComponent(message),
          })
        }).catch(() => {});
      }

      return res.status(200).json({ status: 'notified', count });
    }
  }

  return res.status(200).json({ status: 'recorded', count, threshold: THRESHOLD });
}
