/**
 * CNN Türk – isolierter On-Demand-Test mit Cloudflare Browser Run.
 * Liest AUSSCHLIESSLICH eine in der offiziellen Browser-Wiedergabe
 * erfolgreich (HTTP 200) geladene HLS-Playlist aus.
 * Keine Tokens werden erzeugt, verlängert oder protokolliert.
 * Wenn die offizielle Quelle nicht zugänglich ist, liefert der Worker 502.
 * Dieser Test ist nicht verifiziert gegen den Live-Dienst.
 */
import puppeteer from '@cloudflare/puppeteer';

const SOURCE_PAGE = 'https://www.cnnturk.com/canli-yayin';
const STREAM_HOST = 'live.duhnet.tv';
const WAIT_MS = 13500;

function isAllowedHls(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:'
      && u.hostname === STREAM_HOST
      && /^\/{1,2}S2\/HLS_LIVE\/cnnturknp\//i.test(u.pathname)
      && u.pathname.toLowerCase().endsWith('.m3u8')
      && u.searchParams.has('st')
      && u.searchParams.has('e');
  } catch {
    return false;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Verwendet bewusst kein manueller API-Token-Rebuild und keine Pfadänderung.
 * Es wird nur die URL akzeptiert, die das Browser-Netzwerk als HTTP 200 sah.
 */
async function resolveViaBrowser(browserBinding) {
  const browser = await puppeteer.launch(browserBinding);
  const observations = { pageStatus: null, hls200: 0, hls403: 0, otherHls: 0 };
  let verifiedUrl = null;
  let lastError = null;
  try {
    const page = await browser.newPage();

    page.on('response', (response) => {
      try {
        const responseUrl = response.url();
        // Nur der bekannte HLS-Sender; andere Ressourcen ignorieren.
        if (!isAllowedHls(responseUrl)) return;
        const status = response.status();
        if (status === 200) {
          observations.hls200++;
          // Qualitätsvariante gegenüber einer Master-Playlist bevorzugen.
          const isVariant = /\/track_[^/]+\/playlist\.m3u8/i.test(new URL(responseUrl).pathname);
          if (!verifiedUrl || isVariant) verifiedUrl = responseUrl;
        } else if (status === 403) {
          observations.hls403++;
        } else {
          observations.otherHls++;
        }
      } catch { /* Ein fehlgeschlagenes Browser-Event ist nicht kritisch. */ }
    });

    const pageResponse = await page.goto(SOURCE_PAGE, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });
    observations.pageStatus = pageResponse?.status() ?? null;

    // Der Sender startet häufig selbst; anderenfalls einen Play-Button anklicken.
    const initialDeadline = Date.now() + 3000;
    while (!verifiedUrl && Date.now() < initialDeadline) await sleep(350);
    if (!verifiedUrl) {
      const selectors = [
        '.vjs-big-play-button',
        '.jw-display-icon-container',
        '.plyr__control--overlaid',
        'button[aria-label="Play"]',
        'button[aria-label="Oynat"]'
      ];
      for (const selector of selectors) {
        try {
          const button = await page.$(selector);
          if (button) {
            await button.click({ delay: 30 });
            break;
          }
        } catch { /* Der Player hat eventuell einen anderen Button. */ }
      }
    }

    const deadline = Date.now() + WAIT_MS;
    while (!verifiedUrl && Date.now() < deadline) await sleep(400);
    if (!verifiedUrl) lastError = 'Keine im Cloud-Browser erfolgreich geladene CNN-Tuerk-HLS-Playlist gefunden.';
  } catch (error) {
    lastError = String(error?.message || error).slice(0, 180);
  } finally {
    await browser.close().catch(() => {});
  }
  return { verifiedUrl, observations, error: lastError };
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const path = incoming.pathname;
    if (path === '/') {
      return new Response(`CNN Türk Browser-On-Demand – Testdienst\n\nDiagnose: /status\nIPTV: /cnn-turk.m3u8\n\nNur benutzen, wenn der Test in /status HLS 200 meldet.\n`, {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    if (path !== '/status' && path !== '/cnn-turk.m3u8') return new Response('Nicht gefunden', { status: 404 });
    if (request.method !== 'GET') return new Response('Methode nicht erlaubt', { status: 405 });
    if (!env.MYBROWSER) return json({ ok: false, stage: 'configuration', error: 'Browser-Run-Bindung MYBROWSER fehlt' }, 503);

    let result;
    try {
      result = await resolveViaBrowser(env.MYBROWSER);
    } catch (error) {
      result = { verifiedUrl: null, observations: {}, error: String(error?.message || error).slice(0, 180) };
    }

    const status = {
      ok: !!result.verifiedUrl,
      methode: 'Offizieller CNN-Tuerk-Player im Cloud-Browser',
      offizielleSeite: SOURCE_PAGE,
      pageStatus: result.observations.pageStatus ?? null,
      hls200: result.observations.hls200 ?? 0,
      hls403: result.observations.hls403 ?? 0,
      andereHlsAntworten: result.observations.otherHls ?? 0,
      hinweis: result.verifiedUrl
        ? 'HLS wurde im Cloud-Browser mit HTTP 200 geladen. Die Wiedergabe am IPTV-Player muss noch getestet werden.'
        : result.error || 'Kein vom Cloud-Browser erfolgreicher HLS-Abruf erkannt.',
      hinweisDatenschutz: 'Keine vollstaendige signierte URL, Cookies oder Tokens in der Diagnose.'
    };

    if (path === '/status') return json(status, result.verifiedUrl ? 200 : 502);
    if (!result.verifiedUrl) return json(status, 502);

    // Originale vom Player genutzte URL inkl. doppeltem Slash und Token erhalten.
    // Keine Umformung zu einer ausgedachten oder selbst signierten URL.
    return new Response(null, {
      status: 302,
      headers: { location: result.verifiedUrl, 'cache-control': 'no-store, max-age=0' }
    });
  }
};
