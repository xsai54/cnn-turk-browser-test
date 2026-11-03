/**
 * CNN Türk – getrennter Test: geplante Browser-Abfrage + gemeinsamer KV-Cache.
 * Bei GET /status und /cnn-turk.m3u8 wird KEIN Browser gestartet.
 * Eine Adresse wird nur dann gespeichert, wenn sie außerhalb des Cloud-Browsers
 * durch den Worker als HLS-Playlist geprüft werden konnte.
 * Browser-HLS 200 allein garantiert KEINE IPTV-Wiedergabe.
 */
import puppeteer from '@cloudflare/puppeteer';

const SOURCE = 'https://www.cnnturk.com/canli-yayin';
const KEY = 'cnn-turk:stream-v2';
const WAIT_MS = 8500;
const MIN_VALID_MS = 120000;

function isAllowedHls(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:'
      && u.hostname === 'live.duhnet.tv'
      && /^\/{1,2}S2\/HLS_LIVE\/cnnturknp\//i.test(u.pathname)
      && u.pathname.toLowerCase().endsWith('.m3u8')
      && u.searchParams.has('st')
      && u.searchParams.has('e');
  } catch { return false; }
}

function expiryMs(value) {
  if (!isAllowedHls(value)) return 0;
  const seconds = Number(new URL(value).searchParams.get('e'));
  return Number.isSafeInteger(seconds) ? seconds * 1000 : 0;
}

function active(state, now = Date.now()) {
  return Boolean(state?.url && isAllowedHls(state.url) && expiryMs(state.url) > now + 60000);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function browserProbe(binding) {
  const browser = await puppeteer.launch(binding);
  const info = { pageStatus: null, hls200: 0, hls403: 0, hlsOther: 0 };
  let selected = null;
  try {
    const page = await browser.newPage();
    page.on('response', response => {
      try {
        const url = response.url();
        if (!isAllowedHls(url)) return;
        if (response.status() === 200) {
          info.hls200++;
          if (!selected || /\/track_[^/]+\/playlist\.m3u8/i.test(new URL(url).pathname)) selected = url;
        } else if (response.status() === 403) info.hls403++;
        else info.hlsOther++;
      } catch { /* Ein Browser-Event kann entfallen. */ }
    });

    const response = await page.goto(SOURCE, { waitUntil: 'domcontentloaded', timeout: 18000 });
    info.pageStatus = response?.status() ?? null;
    const first = Date.now() + 2000;
    while (!selected && Date.now() < first) await sleep(250);
    if (!selected) {
      for (const selector of ['.vjs-big-play-button', '.jw-display-icon-container', '.plyr__control--overlaid', 'button[aria-label="Play"]', 'button[aria-label="Oynat"]']) {
        try {
          const el = await page.$(selector);
          if (el) { await el.click(); break; }
        } catch { /* Weiter versuchen. */ }
      }
    }
    const end = Date.now() + WAIT_MS;
    while (!selected && Date.now() < end) await sleep(350);
    return { selected, info, error: selected ? null : 'Keine HLS-Anfrage mit HTTP 200 im Cloud-Browser erkannt' };
  } catch (e) {
    return { selected: null, info, error: String(e?.message || e).slice(0, 140) };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function outsideBrowserProbe(url) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const status = res.status;
    if (status !== 200) { await res.body?.cancel(); return { ok: false, status }; }
    const text = await res.text();
    return { ok: text.trimStart().startsWith('#EXTM3U'), status };
  } catch (e) {
    return { ok: false, status: null, error: String(e?.message || e).slice(0, 100) };
  }
}

async function refresh(env) {
  const before = await env.STREAMS_KV.get(KEY, { type: 'json' }).catch(() => null) || {};
  const state = { ...before, lastAttemptAt: new Date().toISOString(), method: 'Cloud-Browser scheduled' };
  try {
    if (!env.MYBROWSER) throw new Error('Browser-Bindung MYBROWSER fehlt');
    const observation = await browserProbe(env.MYBROWSER);
    state.browserPageStatus = observation.info.pageStatus;
    state.browserHls200 = observation.info.hls200;
    state.browserHls403 = observation.info.hls403;
    if (!observation.selected) throw new Error(observation.error || 'Keine Playlist erkannt');

    // Ist die Adresse auch AUSSERHALB des Browserkontexts abrufbar?
    const independent = await outsideBrowserProbe(observation.selected);
    state.independentHttpStatus = independent.status;
    if (!independent.ok) throw new Error('Browser erfolgreich, aber externer HLS-Test fehlgeschlagen (' + (independent.status || independent.error || '?') + ')');
    if (expiryMs(observation.selected) < Date.now() + MIN_VALID_MS) throw new Error('Stream-Adresse bereits zu nah am Ablauf');

    state.url = observation.selected;
    state.expiresAt = new Date(expiryMs(observation.selected)).toISOString();
    state.verifiedAt = new Date().toISOString();
    state.lastError = null;
    state.consecutiveFailures = 0;
  } catch (e) {
    // Alte Adresse unverändert lassen; nur Diagnose aktualisieren.
    state.lastError = String(e?.message || e).slice(0, 180);
    state.consecutiveFailures = (before.consecutiveFailures || 0) + 1;
  }
  await env.STREAMS_KV.put(KEY, JSON.stringify(state));
  console.log('CNN-Tuerk Aktualisierung:', state.lastError ? 'Kein externer Zugriff nachgewiesen' : 'HLS-Pruefung erfolgreich');
}

export default {
  async scheduled(_controller, env, ctx) {
    if (!env.STREAMS_KV) throw new Error('KV-Bindung STREAMS_KV fehlt');
    const last = await env.STREAMS_KV.get(KEY, { type: 'json' }).catch(() => null);
    const sameUtcDay = last?.lastAttemptAt?.slice(0, 10) === new Date().toISOString().slice(0, 10);
    // Bei anhaltenden 403 / ausgeschopftem Browser-Kontingent keine weiteren Browserstarts heute.
    if (sameUtcDay && ((last.consecutiveFailures || 0) >= 3 || /429|rate limit/i.test(last.lastError || ''))) return;
    ctx.waitUntil(refresh(env));
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Methode nicht erlaubt', { status: 405 });
    if (!['/', '/status', '/cnn-turk.m3u8', '/cnn-turk.m3u'].includes(pathname)) return new Response('Nicht gefunden', { status: 404 });
    if (pathname === '/') return new Response('CNN Tuerk Cache-Test\n/status\n/cnn-turk.m3u8\n/cnn-turk.m3u\nKein Cloud-Browser bei Zuschauerabrufen.\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (!env.STREAMS_KV) return json({ ok: false, error: 'KV-Bindung STREAMS_KV fehlt' }, 503);

    let state;
    try { state = await env.STREAMS_KV.get(KEY, { type: 'json' }); }
    catch { return json({ ok: false, error: 'KV nicht erreichbar' }, 503); }
    const available = active(state);
    if (pathname === '/status') return json({
      ok: available,
      cache: Boolean(state),
      hls200: state?.browserHls200 ?? null,
      streamSeite: state?.browserPageStatus ?? null,
      geprueftAusserhalbBrowser: state?.independentHttpStatus ?? null,
      zuletztGeprueft: state?.lastAttemptAt ?? null,
      zuletztErfolgreich: state?.verifiedAt ?? null,
      gueltigBis: state?.expiresAt ?? null,
      letzterFehler: state?.lastError ?? null,
      aufeinanderfolgendeFehler: state?.consecutiveFailures ?? 0,
      hinweis: 'Status und Master-Link starten keinen Cloud-Browser. Ein HTTP-200-Test beweist noch keine IPTV-Wiedergabe.'
    });

    if (!available) return new Response('CNN Tuerk: derzeit keine extern gepruefte, gueltige HLS-Adresse vorhanden.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

    if (pathname === '/cnn-turk.m3u') {
      const self = new URL('/cnn-turk.m3u8', request.url).toString();
      return new Response('#EXTM3U\n#EXTINF:-1 tvg-id="CNNTurk.tr" group-title="Haber",CNN Turk\n' + self + '\n', {
        headers: { 'content-type': 'audio/x-mpegurl; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    return new Response(null, { status: 302, headers: { location: state.url, 'cache-control': 'no-store' } });
  }
};
