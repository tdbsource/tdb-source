export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

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

  if (req.method === 'POST') {
    // Vercel bazen body'yi string olarak geçirir, parse et
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) { body = {}; }
    }

    const { city, earthquakes, count } = body || {};
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY eksik' });
    if (!city)   return res.status(400).json({ error: 'city parametresi eksik' });

    const eqCount = count || (earthquakes ? earthquakes.length : 0);
    const eqSummary = earthquakes && earthquakes.length > 0
      ? earthquakes.slice(0, 15).map(e =>
          `M${parseFloat(e.mag).toFixed(1)} — ${e.place} — Derinlik: ${e.depth}km — ${e.time}`
        ).join('\n')
      : 'Son 7 günde kayıtlı hareket yok.';

    const prompt = `Sen bir sismoloji uzmanısın. Türkiye'nin ${city} ili için son 7 günlük deprem verilerini analiz et.

Toplam kayıt: ${eqCount} deprem

Deprem Verileri:
${eqSummary}

Lütfen şunları içeren 3-4 cümlelik Türkçe bir analiz yaz:
1. Aktivite yoğunluğu ve genel değerlendirme
2. Büyüklük ve derinlik dağılımı hakkında yorum
3. Bölgenin fay hattı bağlamında genel riski

Sadece analiz metnini yaz, başlık veya madde işareti kullanma.`;

    // Gemini 2.0 Flash — en güncel ve hızlı model
    const GEMINI_MODELS = [
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-flash-latest',
    ];

    for (const model of GEMINI_MODELS) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.5, maxOutputTokens: 450 }
            })
          }
        );

        const data = await response.json();

        // Hata varsa sonraki modeli dene
        if (data.error) {
          console.warn(`Model ${model} hatası:`, data.error.message);
          continue;
        }

        if (data.candidates && data.candidates[0] && data.candidates[0].content) {
          const text = data.candidates[0].content.parts[0].text.trim();
          return res.status(200).json({ analysis: text, model });
        }
      } catch (err) {
        console.warn(`Model ${model} exception:`, err.message);
        continue;
      }
    }

    return res.status(500).json({ error: 'Tüm Gemini modelleri başarısız oldu' });
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
