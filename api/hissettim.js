const THRESHOLD    = parseInt(process.env.HISSET_THRESHOLD || '5');
const WINDOW_MS    = 10 * 1000;
const COOLDOWN_MS  = 30 * 1000;
const NOTIF_CD_MS  = 60 * 1000;

async function redis(cmd) {
  const url   = process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;
  const r = await fetch(url + '/' + cmd.map(encodeURIComponent).join('/'), {
    headers: { Authorization: 'Bearer ' + token }
  });
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const { il } = body || {};
  if (!il) return res.status(400).json({ error: 'il eksik' });

  const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();

  // Kullanıcı cooldown kontrolü
  const ckKey = 'ck:' + ip + ':' + il;
  const ckVal = await redis(['GET', ckKey]);
  if (ckVal.result) {
    return res.status(200).json({ status: 'cooldown', message: 'Kısa süre önce bildirdin.' });
  }
  await redis(['SET', ckKey, '1', 'PX', String(COOLDOWN_MS)]);

  // Kullanıcıyı 10 saniyelik listeye ekle (sorted set: score=ts, member=ip)
  const setKey = 'hs:' + il;
  await redis(['ZADD', setKey, String(now), ip + ':' + now]);
  // Süresi dolan kayıtları temizle
  await redis(['ZREMRANGEBYSCORE', setKey, '0', String(now - WINDOW_MS)]);
  // TTL ayarla
  await redis(['PEXPIRE', setKey, String(WINDOW_MS * 2)]);
  // Kaç farklı kullanıcı var?
  const countRes = await redis(['ZCARD', setKey]);
  const count = countRes.result || 0;

  if (count >= THRESHOLD) {
    // Son bildirim zamanı kontrolü
    const notifKey = 'notif:' + il;
    const lastNotif = await redis(['GET', notifKey]);
    if (!lastNotif.result) {
      await redis(['SET', notifKey, '1', 'PX', String(NOTIF_CD_MS)]);
      await redis(['DEL', setKey]);

      const apiKey = process.env.ONESIGNAL_API_KEY;
      const appId  = process.env.ONESIGNAL_APP_ID;
      if (apiKey && appId) {
        const title   = 'Sarsıntı Hissiyatı';
        const message = il + ' bölgesindeki kullanıcılar sarsıntı hissettiğini bildiriyor.';
        await fetch('https://api.onesignal.com/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Key ' + apiKey },
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
