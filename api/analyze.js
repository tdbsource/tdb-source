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

  // ── GET: EMSC proxy — Türkiye, son 3 gün, tüm büyüklükler ──────────────
  if (req.method === 'GET') {
    try {
      // EMSC FDSN WS-Event: Türkiye bbox, son 3 gün, büyüklük filtresi yok
      const url =
        'https://www.seismicportal.eu/fdsnws/event/1/query' +
        '?starttime=' + get3DaysAgo() +
        '&endtime='   + getNow() +
        '&minlatitude=35.8&maxlatitude=42.2' +
        '&minlongitude=25.6&maxlongitude=44.8' +
        '&orderby=time&limit=2000' +
        '&format=json';

      const r = await fetch(url, {
        headers: { 'User-Agent': 'TDBSource/8 contact@tdbsource.com' },
        signal: AbortSignal.timeout(12000)
      });
      const data = await r.json();

      // EMSC GeoJSON → normalize
      const features = data?.features || [];
      const events = features.map(f => {
        const p = f.properties;
        const [lon, lat, depth] = f.geometry?.coordinates || [0, 0, 0];
        return {
          latitude:  lat,
          longitude: lon,
          depth:     Math.abs(depth),
          magnitude: p.mag ?? p.magnitude ?? 0,
          location:  p.flynn_region || p.place || '',
          province:  '',   // EMSC'de province yok, frontend koordinat ile eşleştirir
          date:      p.time  // ISO UTC — "2026-03-09T10:00:00.000Z"
        };
      });

      return res.status(200).json({ events, source: 'emsc' });
    } catch (err) {
      return res.status(500).json({ error: 'EMSC bağlantı hatası', detail: err.message });
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

function get3DaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 3);
  return d.toISOString();
}
function toTR(d) {
  // AFAD Türkiye saati (UTC+3) bekliyor
  const tr = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  return tr.toISOString().slice(0, 19);
}
function getNow() {
  return toTR(new Date());
}
function getWeekAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return toTR(d);
}
