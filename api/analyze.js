// Basit in-memory cache — aynı il için 10 dakika Gemini'ye tekrar sorma
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 dakika

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: AFAD proxy ──────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const url = 'https://deprem.afad.gov.tr/apiv2/event/filter?start=' + getWeekAgo() + '&end=' + getNow() + '&minmag=0&orderby=timedesc&limit=500&format=json';
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const data = await response.json();
      return res.status(200).json({ events: data });
    } catch (err) {
      return res.status(500).json({ error: 'AFAD bağlantı hatası', detail: err.message });
    }
  }

  // ── POST: Gemini analiz ──────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }

    const { city, earthquakes, count } = body || {};
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY eksik' });
    if (!city)   return res.status(400).json({ error: 'city parametresi eksik' });

    // Cache kontrolü
    const cacheKey = city.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
      return res.status(200).json({ analysis: cached.analysis, cached: true });
    }

    const eqCount = count || (earthquakes ? earthquakes.length : 0);
    const eqSummary = earthquakes && earthquakes.length > 0
      ? earthquakes.slice(0, 10).map(e =>
          `M${parseFloat(e.mag).toFixed(1)} - ${e.place} - ${e.depth}km - ${e.time}`
        ).join('\n')
      : 'Son 7 günde kayıtlı hareket yok.';

    // Kısa prompt — daha az token = rate limit riski azalır
    const prompt = `Sismoloji uzmanı olarak Türkiye'nin ${city} ili için son 7 günlük deprem verilerini analiz et (${eqCount} olay).

Veriler:
${eqSummary}

3 cümlelik Türkçe analiz yaz: aktivite yoğunluğu, derinlik/büyüklük yorumu, fay hattı riski. Başlık veya madde işareti kullanma.`;

    // Ücretsiz planda çalışan modeller (v1beta)
    const MODELS = [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash-8b-001',
      'gemini-1.5-pro',
    ];

    let lastError = '';
    for (const model of MODELS) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.5, maxOutputTokens: 350 }
            })
          }
        );

        const data = await response.json();

        if (data.error) {
          lastError = `${model}: ${data.error.message}`;
          console.warn('Model hatası:', lastError);
          // Rate limit ise bekle ve devam et
          if (data.error.status === 'RESOURCE_EXHAUSTED') continue;
          // Model bulunamadı ise devam et
          if (data.error.status === 'NOT_FOUND') continue;
          continue;
        }

        if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
          const analysis = data.candidates[0].content.parts[0].text.trim();
          // Cache'e yaz
          cache.set(cacheKey, { analysis, ts: Date.now() });
          return res.status(200).json({ analysis, model });
        }
      } catch (err) {
        lastError = `${model}: ${err.message}`;
        console.warn('Exception:', lastError);
        continue;
      }
    }

    // Tüm modeller başarısız — anlamlı fallback döndür
    const maxMag = earthquakes?.length
      ? Math.max(...earthquakes.map(e => parseFloat(e.mag))).toFixed(1)
      : '—';
    const fallback = eqCount > 0
      ? `${city} için son 7 günde ${eqCount} sismik hareket kaydedilmiştir. En büyük deprem M${maxMag} büyüklüğünde ölçülmüştür. Yapay zeka analizi şu an yüklenemedi (API kota limiti).`
      : `${city} için son 7 günde kayıtlı önemli sismik hareket bulunmamaktadır. Bölge şu an sakin görünmektedir.`;

    return res.status(200).json({ analysis: fallback, fallback: true, error: lastError });
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
