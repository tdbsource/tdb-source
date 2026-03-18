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

  const { password, title, message } = body || {};

  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'Yapılandırma hatası' });
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Yetkisiz erişim' });
  if (!title || !message) return res.status(400).json({ error: 'Başlık ve mesaj zorunlu' });

  const apiKey = process.env.ONESIGNAL_API_KEY;
  const appId  = process.env.ONESIGNAL_APP_ID;
  if (!apiKey || !appId) return res.status(500).json({ error: 'Yapılandırma hatası' });

  const r = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Key ' + apiKey
    },
    body: JSON.stringify({
      app_id: appId,
      included_segments: ['Total Subscriptions'],
      headings: { tr: title, en: title },
      contents: { tr: message, en: message },
      chrome_web_icon: 'https://tdb-source.vercel.app/icons/icon-192.png',
      url: 'https://tdb-source.vercel.app/bildirim.html?title=' + encodeURIComponent(title) + '&msg=' + encodeURIComponent(message),
    })
  });

  const data = await r.json();
  if (data.errors) return res.status(400).json({ error: JSON.stringify(data.errors) });

  return res.status(200).json({ success: true, recipients: data.recipients ?? 0 });
}
