/**
 * /api/analyze
 * GET  → AFAD deprem verisi proxy (Gemini YOK)
 * POST → Gemini metin analizi (sadece il tıklandığında frontend'den çağrılır)
 */

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 dk — aynı ile tekrar tıklanırsa Gemini'ye gitme

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: Sadece AFAD proxy — Gemini çağrısı YOK ─────────────────────────
  if (req.method === 'GET') {
    try {
      const url =
        'https://deprem.afad.gov.tr/apiv2/event/filter' +
        '?start=' + getWeekAgo() +
        '&end='   + getNow() +
        '&minmag=0&orderby=timedesc&limit=500&format=json';

      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000)
      });
      const data = await r.json();
      return res.status(200).json({ events: Array.isArray(data) ? data : [] });
    } catch (err) {
      return res.status(500).json({ error: 'AFAD bağlantı hatası', detail: err.message });
    }
  }

  // ── POST: Gemini metin analizi — sadece il tıklandığında çağrılır ────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }

    const { city, earthquakes, count, maxMag } = body || {};
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY eksik' });
    if (!city)   return res.status(400).json({ error: 'city eksik' });

    // Cache — aynı il 10 dk içinde tekrar isterse Gemini'ye gitme
    const cacheKey = city.toLowerCase();
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
      return res.status(200).json({ analysis: hit.analysis, cached: true });
    }

    const eqCount = count ?? earthquakes?.length ?? 0;
    const topMag   = maxMag ?? (earthquakes?.length ? Math.max(...earthquakes.map(e => parseFloat(e.mag))).toFixed(1) : '—');

    const lines = earthquakes?.length
      ? earthquakes.slice(0, 10).map(e => `M${parseFloat(e.mag).toFixed(1)} · ${e.place} · ${e.depth}km · ${e.time}`).join('\n')
      : 'Son 7 günde kayıtlı hareket yok.';

    // Kısa prompt — token tasarrufu
    const prompt =
      `Sismoloji uzmanı olarak Türkiye'nin ${city} ili için son 7 günlük deprem özetini analiz et.\n` +
      `Toplam olay: ${eqCount} | En büyük: M${topMag}\n\n${lines}\n\n` +
      `3 cümlelik Türkçe analiz yaz: aktivite düzeyi, derinlik/büyüklük yorumu, fay hattı riski. Başlık veya madde işareti kullanma.`;

    // Model listesi — ücretsiz planda çalışanlar
    const MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];

    for (const model of MODELS) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10000),
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.5, maxOutputTokens: 300 }
            })
          }
        );
        const data = await r.json();
        if (data.error) { console.warn(model, data.error.message); continue; }
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) {
          cache.set(cacheKey, { analysis: text, ts: Date.now() });
          return res.status(200).json({ analysis: text, model });
        }
      } catch (err) { console.warn(model, err.message); continue; }
    }

    // Tüm modeller başarısız → frontend kendi metnini üretecek
    return res.status(503).json({ error: 'Gemini şu an yanıt vermiyor' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function getNow() {
  return new Date().toISOString().slice(0, 19);
}
function getWeekAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 19);
}
