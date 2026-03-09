export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { city, earthquakes } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) return res.status(500).json({ error: 'API key eksik' });

  // Deprem verilerini özetle
  const eqSummary = earthquakes && earthquakes.length > 0
    ? earthquakes.slice(0, 20).map(e =>
        `M${e.mag} - ${e.place} - Derinlik: ${e.depth}km - ${e.time}`
      ).join('\n')
    : 'Son 7 günde kayıtlı hareket yok.';

  const prompt = `Sen bir sismoloji uzmanısın. Türkiye'nin ${city} ili için aşağıdaki son 7 günlük deprem verilerini analiz et.

Deprem Verileri:
${eqSummary}

Lütfen şunları içeren 4-5 cümlelik Türkçe bir analiz yaz:
1. Aktivite yoğunluğu ve genel değerlendirme
2. Derinlik ve büyüklük dağılımı hakkında yorum
3. Bölgenin fay hattı bağlamında genel riski

Sadece analiz metnini yaz, başlık veya madde işareti kullanma.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 400 }
        })
      }
    );

    const data = await response.json();

    if (data.candidates && data.candidates[0]) {
      const text = data.candidates[0].content.parts[0].text;
      return res.status(200).json({ analysis: text.trim() });
    } else {
      return res.status(500).json({ error: 'Gemini yanıt vermedi', detail: data });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası', detail: err.message });
  }
}
