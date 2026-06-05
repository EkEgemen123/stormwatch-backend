/* ═══════════════════════════════════════════════════════════════
   STORMWATCH BACKEND — index.js
   Render.com'da çalışır.
   - Web Push (site kapalıyken bildirim)
   - Groq AI analiz endpoint'i (Netlify'dan çağrılır)
   - Her 15 dk Open-Meteo kontrol + abone bildirimi
   ═══════════════════════════════════════════════════════════════ */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const webpush  = require('web-push');
const app      = express();

// ── CONFIG ────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3001;
const CHECK_INTERVAL = (parseInt(process.env.CHECK_INTERVAL_MINUTES) || 15) * 60 * 1000;
const VAPID_PUBLIC   = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE  = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL    = process.env.VAPID_EMAIL       || 'mailto:admin@stormwatch.app';
const GROQ_KEY       = process.env.GROQ_API_KEY      || '';
const FRONTEND_URL   = process.env.FRONTEND_URL      || '*';

// VAPID kontrol
if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('❌ VAPID key eksik!');
  console.error('   Render Dashboard → Environment → şunları ekle:');
  console.error('   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY');
  console.error('   Üretmek için: npm run gen-vapid');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(cors({
  origin: [FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5500', /netlify\.app$/],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '10kb' }));

// ── ABONE VERİTABANI ─────────────────────────────────────────
// Production'da Redis/PostgreSQL kullan. Render'da ücretsiz PostgreSQL var.
// Şimdilik bellek (sunucu restart'ta sıfırlanır — uyarı gösterilir)
const subscribers = new Map();
console.warn('⚠️  Aboneler bellekte tutuluyor. Render restart\'ta sıfırlanır.');
console.warn('   Production için Render PostgreSQL ekle.');

// ── ENDPOINTS ─────────────────────────────────────────────────

// Health check — Render bunu kullanır
app.get('/', (req, res) => {
  res.json({
    service:     'StormWatch Backend',
    status:      'running',
    subscribers: subscribers.size,
    uptime:      Math.floor(process.uptime()),
    ai:          !!GROQ_KEY,
  });
});

// VAPID public key — frontend buna ihtiyaç duyar
app.get('/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Abone ol
app.post('/push/subscribe', (req, res) => {
  const { subscription, lat, lon, lang, locationName } = req.body;

  if (!subscription?.endpoint || lat === undefined || lon === undefined) {
    return res.status(400).json({ error: 'subscription, lat, lon zorunlu' });
  }

  const id = Buffer.from(subscription.endpoint).toString('base64').slice(-24);
  subscribers.set(id, {
    id,
    subscription,
    lat:          parseFloat(lat),
    lon:          parseFloat(lon),
    lang:         lang || 'tr',
    locationName: locationName || '',
    lastAlert:    {},
    subscribedAt: new Date().toISOString(),
  });

  console.log(`[+] Abone: ${locationName || `${lat},${lon}`} | Toplam: ${subscribers.size}`);
  res.json({ ok: true, id, subscriberCount: subscribers.size });
});

// Konum güncelle
app.post('/push/update-location', (req, res) => {
  const { endpoint, lat, lon, locationName, lang } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint gerekli' });

  const id  = Buffer.from(endpoint).toString('base64').slice(-24);
  const sub = subscribers.get(id);
  if (!sub) return res.status(404).json({ error: 'Abone bulunamadı' });

  if (lat !== undefined) sub.lat = parseFloat(lat);
  if (lon !== undefined) sub.lon = parseFloat(lon);
  if (locationName)      sub.locationName = locationName;
  if (lang)              sub.lang = lang;
  subscribers.set(id, sub);

  res.json({ ok: true });
});

// Abonelikten çık
app.post('/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) {
    const id = Buffer.from(endpoint).toString('base64').slice(-24);
    subscribers.delete(id);
  }
  res.json({ ok: true });
});

// İstatistik
app.get('/push/stats', (req, res) => {
  res.json({
    subscribers: subscribers.size,
    uptime:      Math.floor(process.uptime()),
    interval:    CHECK_INTERVAL / 60000 + ' dakika',
    ai:          !!GROQ_KEY,
    vapid:       !!VAPID_PUBLIC,
  });
});

// ── AI ANALİZ ENDPOINT (Netlify Function yerine burası) ───────
app.post('/api/ai-analyze', async (req, res) => {
  if (!GROQ_KEY) {
    return res.status(503).json({ error: 'GROQ_API_KEY tanımlı değil' });
  }

  const { weatherData, radarAnalysis, lang = 'tr', mode = 'analyze' } = req.body;
  if (!weatherData) return res.status(400).json({ error: 'weatherData eksik' });

  try {
    const result = await callGroq(weatherData, radarAnalysis, lang, mode);
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HAVA KONTROLÜ + BİLDİRİM SİSTEMİ ─────────────────────────

function isWeatherEvent(wc) {
  return (wc >= 51 && wc <= 67) ||
         (wc >= 71 && wc <= 77) ||
         (wc >= 80 && wc <= 86) ||
         wc === 95 ||
         (wc >= 96 && wc <= 99);
}

function findNowIndex(times) {
  const iso = new Date().toISOString().slice(0, 13);
  const i   = times.findIndex(t => t.startsWith(iso));
  return i >= 0 ? i : 0;
}

async function fetchWeather(lat, lon) {
  const { default: fetch } = await import('node-fetch');
  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${lat}&longitude=${lon}`
    + `&current=temperature_2m,apparent_temperature,precipitation,rain,snowfall,`
    + `weather_code,wind_speed_10m,wind_gusts_10m,pressure_msl,relative_humidity_2m`
    + `&hourly=weather_code,wind_gusts_10m,cape,precipitation_probability`
    + `&wind_speed_unit=kmh&timezone=auto&forecast_days=2`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

async function getAIComment(wc, temp, gust, rain, snow, pr, nextWc, city, lang) {
  if (!GROQ_KEY) return '';
  try {
    const { default: fetch } = await import('node-fetch');
    const L    = lang === 'en' ? 'en' : 'tr';
    const isS  = wc >= 71;
    const prompt = L === 'tr'
      ? `Maks 55 kelime. Meteoroloji uyarısı:\n${city} — WMO:${wc}, ${temp}°C, ani rüzgar:${gust}km/h, basınç:${pr}hPa, ${isS ? `kar:${snow}mm` : `yağış:${rain}mm`}. 1 saat sonra WMO:${nextWc}. Tehlikeyse ⚠️ koy.`
      : `Max 55 words. Weather alert:\n${city} — WMO:${wc}, ${temp}°C, gusts:${gust}km/h, pressure:${pr}hPa, ${isS ? `snow:${snow}mm` : `rain:${rain}mm`}. Next 1h WMO:${nextWc}. Add ⚠️ if dangerous.`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 90, temperature: 0.3,
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return '';
    const d = await res.json();
    return d.choices?.[0]?.message?.content?.trim() || '';
  } catch { return ''; }
}

async function checkAndNotify(sub) {
  try {
    const data     = await fetchWeather(sub.lat, sub.lon);
    const c        = data.current;
    const nowIdx   = findNowIndex(data.hourly?.time || []);
    const nextWcs  = (data.hourly?.weather_code || []).slice(nowIdx + 1, nowIdx + 5);
    const nextGusts= (data.hourly?.wind_gusts_10m || []).slice(nowIdx + 1, nowIdx + 5);
    const maxNextWc    = Math.max(...nextWcs, 0);
    const maxNextGust  = Math.max(...nextGusts, 0);

    const wc   = c.weather_code;
    const temp = Math.round(c.temperature_2m);
    const gust = Math.round(c.wind_gusts_10m);
    const rain = (c.rain || 0).toFixed(1);
    const snow = (c.snowfall || 0).toFixed(1);
    const pr   = Math.round(c.pressure_msl);
    const city = (sub.locationName || `${sub.lat.toFixed(2)},${sub.lon.toFixed(2)}`).split(',')[0];
    const L    = sub.lang === 'en' ? 'en' : 'tr';

    const nowEvent  = isWeatherEvent(wc);
    const nextEvent = isWeatherEvent(maxNextWc);
    if (!nowEvent && !nextEvent) return;

    // Cooldown kontrolü
    const now  = Date.now();
    const cdKey = nowEvent ? `w${wc}` : `n${maxNextWc}`;
    const cd    = (wc >= 95 || maxNextWc >= 95) ? 10 * 60 * 1000
                : (wc >= 80 || maxNextWc >= 80) ? 20 * 60 * 1000
                : nowEvent                       ? 30 * 60 * 1000
                :                                 45 * 60 * 1000;

    if (sub.lastAlert[cdKey] && (now - sub.lastAlert[cdKey]) < cd) return;
    sub.lastAlert[cdKey] = now;

    // Bildirim içeriği belirle
    let title, body, vibrate, requireInteraction;

    if (nowEvent) {
      if (wc >= 96) {
        title = L==='tr' ? '🌨 DOLU UYARISI!'         : '🌨 HAIL WARNING!';
        body  = L==='tr' ? `${city} · Dolulu fırtına! Rüzgar: ${gust} km/h`
                         : `${city} · Hailstorm! Wind: ${gust} km/h`;
        vibrate=[500,100,500,100,500,100,500]; requireInteraction=true;
      } else if (wc === 95) {
        title = L==='tr' ? '⛈ FIRTINA UYARISI!'       : '⛈ STORM WARNING!';
        body  = L==='tr' ? `${city} · Gök gürültülü fırtına! Rüzgar: ${gust} km/h`
                         : `${city} · Thunderstorm! Wind: ${gust} km/h`;
        vibrate=[500,100,500,100,500]; requireInteraction=true;
      } else if (wc >= 82 || (wc>=75&&wc<=77)) {
        const s = wc>=71;
        title = s ? (L==='tr'?'❄️ Yoğun Kar!':'❄️ Heavy Snow!')
                  : (L==='tr'?'⛈ Şiddetli Yağmur!':'⛈ Heavy Rain!');
        body  = L==='tr' ? `${city} · ${s?`Kar:${snow}mm`:`Yağış:${rain}mm`} · Rüzgar:${gust}km/h`
                         : `${city} · ${s?`Snow:${snow}mm`:`Rain:${rain}mm`} · Wind:${gust}km/h`;
        vibrate=[300,100,300,100,300]; requireInteraction=false;
      } else {
        const s = wc>=71;
        title = s ? (L==='tr'?'🌨 Kar Yağıyor':'🌨 Snowfall')
                  : (L==='tr'?'🌧 Yağmur Yağıyor':'🌧 Rain');
        body  = L==='tr' ? `${city} · ${s?`Kar:${snow}mm`:`Yağış:${rain}mm`} · ${temp}°C`
                         : `${city} · ${s?`Snow:${snow}mm`:`Rain:${rain}mm`} · ${temp}°C`;
        vibrate=[200,100,200]; requireInteraction=false;
      }
    } else {
      if (maxNextWc >= 95) {
        title = L==='tr' ? '⚡ 1 Saat İçinde Fırtına!' : '⚡ Storm in 1 Hour!';
        body  = L==='tr' ? `${city} · Fırtına geliyor! Ani rüzgar: ${maxNextGust} km/h`
                         : `${city} · Storm incoming! Gusts: ${maxNextGust} km/h`;
        vibrate=[400,100,400,100,400]; requireInteraction=true;
      } else if (maxNextWc >= 80) {
        const s = maxNextWc>=71;
        title = s ? (L==='tr'?'❄️ 1s İçinde Yoğun Kar':'❄️ Heavy Snow in 1h')
                  : (L==='tr'?'⛈ 1s İçinde Şiddetli Yağmur':'⛈ Heavy Rain in 1h');
        body  = L==='tr' ? `${city} · Hazırlıklı olun · ${temp}°C`
                         : `${city} · Be prepared · ${temp}°C`;
        vibrate=[300,100,300]; requireInteraction=false;
      } else {
        const s = maxNextWc>=71;
        title = s ? (L==='tr'?'🌨 1s İçinde Kar':'🌨 Snow in 1h')
                  : (L==='tr'?'🌧 1s İçinde Yağmur':'🌧 Rain in 1h');
        body  = L==='tr' ? `${city} · Şemsiyeni al · ${temp}°C`
                         : `${city} · Grab umbrella · ${temp}°C`;
        vibrate=[200,100,200]; requireInteraction=false;
      }
    }

    // AI yorum ekle
    const ai = await getAIComment(wc, temp, gust, rain, snow, pr, maxNextWc, city, L);
    if (ai) body += `\n\n🤖 ${ai.slice(0, 90)}`;

    // Web Push gönder
    await webpush.sendNotification(
      sub.subscription,
      JSON.stringify({
        title, body,
        icon:  '/assets/icons/icon-192.png',
        badge: '/assets/icons/badge-96.png',
        vibrate, requireInteraction,
        tag:     `sw-${cdKey}`,
        renotify: true,
        data:    { url: '/' },
        actions: [
          { action:'view',    title: L==='tr'?'🗺 Haritaya Bak':'🗺 View Map' },
          { action:'dismiss', title: L==='tr'?'✖ Kapat':'✖ Dismiss' },
        ],
      })
    );
    console.log(`[✓ Push] ${city} → ${title}`);

  } catch(err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      subscribers.delete(sub.id);
      console.log(`[- Sub] Silindi (${err.statusCode}): ${sub.locationName}`);
    } else {
      console.error(`[✗ Push] ${sub.locationName}: ${err.message}`);
    }
  }
}

async function runCheck() {
  if (!subscribers.size) return;
  console.log(`\n[Check] ${new Date().toLocaleTimeString('tr-TR')} — ${subscribers.size} abone`);
  const list   = Array.from(subscribers.values());
  // 10'arlı gruplar halinde paralel
  for (let i = 0; i < list.length; i += 10) {
    await Promise.allSettled(list.slice(i, i + 10).map(checkAndNotify));
  }
  console.log('[Check] Tamamlandı.');
}

// ── GROQ AI (frontend çağrısı için) ──────────────────────────
async function callGroq(weatherData, radarAnalysis, lang, mode) {
  const { default: fetch } = await import('node-fetch');
  const w  = weatherData;
  const L  = lang === 'en' ? 'en' : 'tr';
  const maxTok = mode === 'report' ? 150 : 450;

  const systemMsg = L === 'tr'
    ? `Sen deneyimli bir Türk meteorologsun. Verileri analiz et, net değerlendirme yap, tavsiye ver. Emoji kullan. Maks ${Math.floor(maxTok/3)} kelime.`
    : `You are an experienced meteorologist. Analyze data, give clear assessment and advice. Use emojis. Max ${Math.floor(maxTok/3)} words.`;

  const radarPart = radarAnalysis
    ? (L==='tr'
        ? `\nRADAR: Yoğunluk ${radarAnalysis.currentIntensity}/5 · Trend: ${radarAnalysis.trendLabel}${radarAnalysis.etaMinutes ? ` · ⚠️ VARIŞ: ${radarAnalysis.etaMinutes}dk` : ''}`
        : `\nRADAR: Intensity ${radarAnalysis.currentIntensity}/5 · Trend: ${radarAnalysis.trendLabel}${radarAnalysis.etaMinutes ? ` · ⚠️ ETA: ${radarAnalysis.etaMinutes}min` : ''}`)
    : '';

  const prompt = L === 'tr'
    ? `${mode === 'report' ? 'Kısa 1 saatlik rapor (maks 80 kelime)' : 'Detaylı meteoroloji analizi'}:\n${w.locationName||'?'} · WMO:${w.wcode} · ${w.temp}°C (his:${w.feelsLike}°C)\nRüzgar:${w.windSpd}km/h ani:${w.windGust}km/h · Basınç:${w.pressure}hPa ${w.pressTrend}\nNem:${w.humidity}% · Çiğ:${w.dewPoint}°C · CAPE:${w.cape}J/kg\nYağış:${w.rain}mm / Kar:${w.snow}mm · Görüş:${w.vis}km · UV:${w.uv}\nTehdit:${w.threatScore}/100${radarPart}\n${mode!=='report'?'1. Durum 2. 1-2 saat sonrası 3. Tehlikeler 4. Tavsiyeler':''}`
    : `${mode === 'report' ? 'Short 1hr report (max 80 words)' : 'Detailed meteorological analysis'}:\n${w.locationName||'?'} · WMO:${w.wcode} · ${w.temp}°C (feels:${w.feelsLike}°C)\nWind:${w.windSpd}km/h gusts:${w.windGust}km/h · Pressure:${w.pressure}hPa ${w.pressTrend}\nHumidity:${w.humidity}% · Dew:${w.dewPoint}°C · CAPE:${w.cape}J/kg\nRain:${w.rain}mm / Snow:${w.snow}mm · Vis:${w.vis}km · UV:${w.uv}\nThreat:${w.threatScore}/100${radarPart}\n${mode!=='report'?'1.Situation 2.Next 1-2hr 3.Hazards 4.Advice':''}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:       mode === 'report' ? 'llama-3.1-8b-instant' : 'llama-3.3-70b-versatile',
      messages:    [{ role:'system', content: systemMsg }, { role:'user', content: prompt }],
      max_tokens:  maxTok,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Groq ${res.status}`); }
  const d = await res.json();
  return { text: d.choices?.[0]?.message?.content?.trim() || '', tokens: d.usage?.total_tokens || 0, model: d.model, timestamp: Date.now() };
}

// ── ZAMANLAYICI ───────────────────────────────────────────────
let timer = null;
function startScheduler() {
  console.log(`[Scheduler] Her ${CHECK_INTERVAL/60000} dk'da bir kontrol`);
  runCheck();
  timer = setInterval(runCheck, CHECK_INTERVAL);
}

// ── BAŞLAT ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('⚡ ═══════════════════════════════════════════');
  console.log('   STORMWATCH Backend — Render.com');
  console.log(`   Port     : ${PORT}`);
  console.log(`   Interval : ${CHECK_INTERVAL/60000} dakika`);
  console.log(`   AI (Groq): ${GROQ_KEY ? 'Aktif ✓' : 'Devre dışı'}`);
  console.log(`   VAPID    : ${VAPID_PUBLIC ? 'Hazır ✓' : 'EKSİK ✗'}`);
  console.log(`   CORS     : ${FRONTEND_URL}`);
  console.log('⚡ ═══════════════════════════════════════════');
  console.log('');
  startScheduler();
});

process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
process.on('SIGINT',  () => { clearInterval(timer); process.exit(0); });
