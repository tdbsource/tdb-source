export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Kandilli proxy (GET)
  if (req.method === 'GET') {
    try {
      const response = await fetch('http://www.koeri.boun.edu.tr/scripts/lst0.asp', {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const text = await response.text();
      return res.status(200).json({ contents: text });
    } catch (err) {
      return res.status(500).json({ error: 'Kandilli bağlantı hatası', detail: err.message });
    }
  }

  // Gemini analizi (POST)
  if (req.method === 'POST') {
    const { city, earthquakes } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key eksik' });

    const eqSummary = earthquakes && earthquakes.length > 0
      ? earthquakes.slice(0, 15).map(e =>
          `M${e.mag} - ${e.place} - Derinlik: ${e.depth}km - ${e.time}`
        ).join('\n')
      : 'Son 7 günde kayıtlı hareket yok.';

    const prompt = `Sen bir sismoloji uzmanısın. Türkiye'nin ${city} ili için aşağıdaki son 7 günlük deprem verilerini analiz et.

Deprem Verileri:
${eqSummary}

Lütfen şunları içeren 3-4 cümlelik Türkçe bir analiz yaz:
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
        return res.status(500).json({ error: 'Gemini yanıt vermedi', detail: JSON.stringify(data) });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Sunucu hatası', detail: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
```

Commit ettikten sonra şu URL'yi tekrar aç ve ne yazdığını söyle:
```
https://tdb-source.vercel.app/api/analyze
