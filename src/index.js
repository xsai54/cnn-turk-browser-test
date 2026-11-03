/**
 * CNN Türk – gemeinsamer IPTV-Master-Link mit GitHub-Refresh.
 * Dieser Worker startet KEINEN Browser, lädt keine Videosegmente und verändert
 * die original signierte Anbieter-URL nicht.
 * Quelle: offizielle CNN Türk Liveseite; nur für erlaubte Nutzung.
 */
const KEY = 'cnn-turk:github-refresh:v3';
const MAX_CACHE_AGE_MS = 45 * 60 * 1000;
const MIN_REMAINING_MS = 90 * 1000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  }});
}
function isAllowedHls(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('https://')) return false;
  try {
    const url = new URL(value);
    if (url.hostname !== 'live.duhnet.tv' || url.username || url.password || url.port) return false;
    if (!/^\/{1,2}S2\/HLS_LIVE\/cnnturknp\/(?:track_[\w-]+\/)?playlist\.m3u8$/i.test(url.pathname)) return false;
    const expiry = Number(url.searchParams.get('e'));
    const token = url.searchParams.get('st');
    return Boolean(token && token.length >= 8 && Number.isSafeInteger(expiry) && expiry * 1000 > now + MIN_REMAINING_MS);
  } catch { return false; }
}
function isAvailable(record, now = Date.now()) {
  const updated = Date.parse(record?.updatedAt || '');
  return Boolean(record?.url && Number.isFinite(updated) && now - updated >= 0
    && now - updated < MAX_CACHE_AGE_MS && isAllowedHls(record.url, now));
}
function auth(request, expected) {
  return typeof expected === 'string' && expected.length >= 24
    && request.headers.get('Authorization') === 'Bearer ' + expected;
}
async function readRecord(env) {
  if (!env.STREAMS_KV) throw new Error('KV-Bindung STREAMS_KV fehlt');
  return await env.STREAMS_KV.get(KEY, { type: 'json' });
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/internal/sync') {
      if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
      if (!auth(request, env.SYNC_TOKEN)) return json({ ok: false, error: 'Nicht autorisiert' }, 401);
      if (!env.STREAMS_KV) return json({ ok: false, error: 'KV-Bindung fehlt' }, 503);
      let payload;
      try { payload = await request.json(); } catch { return json({ok:false,error:'Ungueltiges JSON'},400); }
      const now = Date.now();
      if (payload?.ok === true && isAllowedHls(payload.url, now)) {
        const state = {
          url: payload.url, updatedAt: new Date(now).toISOString(),
          checkedBy: 'GitHub Chromium + externer HLS-Test',
          lastCheckOk: true, lastError: null
        };
        await env.STREAMS_KV.put(KEY, JSON.stringify(state));
        return json({ ok: true, stored: true, updatedAt: state.updatedAt });
      }
      // Fehler niemals als scheinbar gueltigen Stream speichern.
      const current = await readRecord(env) || {};
      const state = { ...current, lastCheckOk: false, lastCheckAt: new Date(now).toISOString(),
        lastError: 'Bei GitHub keine extern abrufbare HLS-Adresse nachgewiesen' };
      await env.STREAMS_KV.put(KEY, JSON.stringify(state));
      return json({ ok: true, stored: false, reason: 'Keine validierte HLS-Adresse' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 });
    if (!['/', '/status', '/cnn-turk.m3u8', '/cnn-turk.m3u'].includes(path)) return new Response('Nicht gefunden', { status: 404 });
    if (path === '/') return new Response('CNN Tuerk: /status /cnn-turk.m3u8 /cnn-turk.m3u\nGitHub aktualisiert den KV-Cache; Zuschauer starten keinen Browser.\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' }});
    let state;
    try { state = await readRecord(env); }
    catch (error) { return json({ok:false,error:String(error.message||error)},503); }
    const ready = isAvailable(state);
    if (path === '/status') return json({
      ok: ready, methode: 'GitHub Chromium alle 15 Minuten, Cloudflare KV',
      zuletztGespeichert: state?.updatedAt || null,
      letztePruefungErfolgreich: state?.lastCheckOk ?? null,
      letzteFehlerpruefung: state?.lastCheckAt || null,
      hinweis: state?.lastError || (ready ? 'Stream-Adresse zwischengespeichert. IPTV-Wiedergabe noch nicht garantiert.' : 'Noch keine gueltige Stream-Adresse vorhanden.'),
      browserStartsProZuschauer: 0
    });
    if (!ready) return new Response('CNN Tuerk: Aktuell keine gueltige, extern gepruefte HLS-Adresse vorhanden.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
    if (path === '/cnn-turk.m3u') {
      const master = new URL('/cnn-turk.m3u8', request.url).toString();
      return new Response('#EXTM3U\n#EXTINF:-1 tvg-id="CNNTurk.tr" group-title="Haber",CNN Türk\n' + master + '\n', {
        status: 200, headers: { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }
    return new Response(null, { status: 302, headers: {
      'Location': state.url, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    }});
  }
};
