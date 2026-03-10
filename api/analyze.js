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

        // EMSC "place" alanı bazen "12 km NE of Denizli" gibi gelir — onu kullan
        // flynn_region "WESTERN TURKEY" gibi anlamsız — sadece fallback
        const rawPlace = p.place || p.description || '';
        const nearMatch = rawPlace.match(/of\s+([\w\s\u00C0-\u024F]+)/i);
        const nearCity  = nearMatch ? nearMatch[1].trim() : '';

        // Koordinata en yakın Türk ilini bul
        const nearest = nearestProvince(lat, lon);

        // Gösterilecek yer: "Denizli" veya "Denizli (Acıpayam)" gibi
        const location = nearest
          ? (nearCity && !nearCity.toUpperCase().includes('TURKEY') ? nearCity + ', ' + nearest : nearest)
          : (nearCity || rawPlace);

        return {
          latitude:  lat,
          longitude: lon,
          depth:     Math.abs(depth),
          magnitude: p.mag ?? p.magnitude ?? 0,
          location,
          province:  nearest ? nearest.toLowerCase() : '',
          date:      p.time
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

    const { city, cityId, earthquakes, count, maxMag, ctx } = body || {};
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

    // İl bağlamını prompt'a ekle — her il için özgün analiz üretilsin
    const ctxNote = ctx
      ? `Tektonik bağlam: ${city}, ${ctx.fay} konumundadır. ${ctx.not}.`
      : ``;

    const prompt =
      `Sen bir sismoloji uzmanısın. Türkiye'nin ${city} ili için son deprem verilerini analiz et.\n\n` +
      `${ctxNote}\n\n` +
      `Güncel veriler (son 3 gün, toplam ${eqCount} olay, en büyük M${topMag}):\n${lines}\n\n` +
      `Yukarıdaki tektonik bağlamı ve güncel verileri birlikte değerlendirerek 3 cümlelik özgün Türkçe analiz yaz. ` +
      `Bu ilin kendine özgü fay yapısına ve tarihsel sismisitesine mutlaka değin. ` +
      `Başlık, madde işareti veya genel kalıplar kullanma; doğrudan analize gir.`;

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

// Türkiye il merkezleri — koordinata en yakın ili döndürür
const TR_PROVINCES = [
  {n:'İstanbul',  lat:41.01,lon:28.96},{n:'İzmir',     lat:38.42,lon:27.14},
  {n:'Ankara',    lat:39.93,lon:32.85},{n:'Bursa',     lat:40.18,lon:29.06},
  {n:'Kocaeli',   lat:40.77,lon:29.92},{n:'Sakarya',   lat:40.69,lon:30.43},
  {n:'Düzce',     lat:40.84,lon:31.16},{n:'Tekirdağ',  lat:41.08,lon:27.51},
  {n:'Edirne',    lat:41.68,lon:26.56},{n:'Kırklareli',lat:41.73,lon:27.22},
  {n:'Çanakkale', lat:40.15,lon:26.41},{n:'Balıkesir', lat:39.65,lon:27.88},
  {n:'Bilecik',   lat:40.14,lon:29.98},{n:'Yalova',    lat:40.65,lon:29.27},
  {n:'Muğla',     lat:37.21,lon:28.36},{n:'Aydın',     lat:37.85,lon:27.84},
  {n:'Manisa',    lat:38.61,lon:27.43},{n:'Denizli',   lat:37.78,lon:29.10},
  {n:'Kütahya',   lat:39.42,lon:29.98},{n:'Uşak',      lat:38.68,lon:29.41},
  {n:'Afyonkarahisar',lat:38.76,lon:30.54},{n:'Samsun',lat:41.29,lon:36.33},
  {n:'Bolu',      lat:40.74,lon:31.61},{n:'Zonguldak', lat:41.46,lon:31.80},
  {n:'Bartın',    lat:41.64,lon:32.34},{n:'Karabük',   lat:41.20,lon:32.62},
  {n:'Kastamonu', lat:41.38,lon:33.78},{n:'Sinop',     lat:42.02,lon:35.15},
  {n:'Ordu',      lat:40.98,lon:37.88},{n:'Giresun',   lat:40.91,lon:38.39},
  {n:'Trabzon',   lat:41.00,lon:39.72},{n:'Rize',      lat:41.02,lon:40.52},
  {n:'Artvin',    lat:41.18,lon:41.82},{n:'Konya',     lat:37.87,lon:32.49},
  {n:'Kayseri',   lat:38.73,lon:35.49},{n:'Eskişehir', lat:39.78,lon:30.52},
  {n:'Sivas',     lat:39.75,lon:37.02},{n:'Yozgat',    lat:39.82,lon:34.81},
  {n:'Aksaray',   lat:38.37,lon:34.03},{n:'Nevşehir',  lat:38.62,lon:34.71},
  {n:'Kırşehir',  lat:39.15,lon:34.17},{n:'Kırıkkale', lat:39.85,lon:33.51},
  {n:'Çankırı',   lat:40.60,lon:33.62},{n:'Karaman',   lat:37.18,lon:33.22},
  {n:'Hatay',     lat:36.40,lon:36.35},{n:'Adana',     lat:37.00,lon:35.32},
  {n:'Mersin',    lat:36.81,lon:34.64},{n:'Antalya',   lat:36.89,lon:30.71},
  {n:'Isparta',   lat:37.76,lon:30.55},{n:'Burdur',    lat:37.72,lon:30.29},
  {n:'Osmaniye',  lat:37.07,lon:36.25},{n:'Niğde',     lat:37.97,lon:34.68},
  {n:'Kahramanmaraş',lat:37.58,lon:36.94},{n:'Elazığ', lat:38.67,lon:39.22},
  {n:'Malatya',   lat:38.35,lon:38.31},{n:'Erzincan',  lat:39.75,lon:39.49},
  {n:'Tunceli',   lat:39.11,lon:39.55},{n:'Gaziantep', lat:37.06,lon:37.38},
  {n:'Adıyaman',  lat:37.76,lon:38.27},{n:'Diyarbakır',lat:37.91,lon:40.22},
  {n:'Bingöl',    lat:38.88,lon:40.50},{n:'Erzurum',   lat:39.90,lon:41.27},
  {n:'Van',       lat:38.50,lon:43.38},{n:'Muş',       lat:38.75,lon:41.50},
  {n:'Ağrı',      lat:39.72,lon:43.05},{n:'Kars',      lat:40.60,lon:43.10},
  {n:'Ardahan',   lat:41.11,lon:42.70},{n:'Iğdır',     lat:39.89,lon:44.05},
  {n:'Bitlis',    lat:38.40,lon:42.11},{n:'Hakkari',   lat:37.57,lon:43.74},
  {n:'Şanlıurfa', lat:37.16,lon:38.80},{n:'Mardin',    lat:37.31,lon:40.74},
  {n:'Batman',    lat:37.88,lon:41.13},{n:'Siirt',     lat:37.93,lon:41.95},
  {n:'Şırnak',    lat:37.52,lon:42.46},{n:'Kilis',     lat:36.72,lon:37.12},
  {n:'Çorum',     lat:40.55,lon:34.96},{n:'Amasya',    lat:40.65,lon:35.84},
  {n:'Tokat',     lat:40.31,lon:36.55},{n:'Gümüşhane', lat:40.46,lon:39.48},
  {n:'Bayburt',   lat:40.26,lon:40.23},{n:'Ankara',    lat:39.93,lon:32.85},
];

function nearestProvince(lat, lon) {
  // Türkiye bbox dışındaysa boş döndür
  if (lat < 35.5 || lat > 42.5 || lon < 25.0 || lon > 45.0) return '';
  let best = null, bestD = Infinity;
  for (const p of TR_PROVINCES) {
    const d = Math.sqrt((lat - p.lat) ** 2 + (lon - p.lon) ** 2);
    if (d < bestD) { bestD = d; best = p.n; }
  }
  // 2 derece (~220 km) içinde değilse belirsiz
  return bestD < 2.0 ? best : '';
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
