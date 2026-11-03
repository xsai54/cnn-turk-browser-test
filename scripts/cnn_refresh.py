"""CNN Türk: offizielle Browser-Wiedergabe beobachten und URL unabhaengig pruefen.

Keine Umgehung von Zugriffsschutz, kein Videoproxy. Nur Links, die sich ohne
Browser-Cookies und ohne spezielle Referer-Anforderungen abrufen lassen,
werden zum Worker uebertragen. Keine signierten URLs in GitHub-Logs ausgeben.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

SOURCE = 'https://www.cnnturk.com/canli-yayin'
WORKER_URL = os.environ.get('WORKER_URL', '').rstrip('/')
TOKEN = os.environ.get('SYNC_TOKEN', '')
TARGET_TRACK = 'track_3_754'  # Nur im Original beobachtete oder in der Master-Playlist angebotene Variante


def is_allowed(url, now=None):
    try:
        u = urllib.parse.urlsplit(url)
        if u.scheme != 'https' or u.hostname != 'live.duhnet.tv' or u.port or u.username:
            return False
        if not re.fullmatch(r'/{1,2}S2/HLS_LIVE/cnnturknp/(?:track_[\w-]+/)?playlist\.m3u8', u.path, re.I):
            return False
        params = urllib.parse.parse_qs(u.query)
        expiry = int(params.get('e', ['0'])[0])
        return bool(params.get('st', [''])[0]) and expiry > (now if now is not None else time.time()) + 90
    except (ValueError, TypeError):
        return False


def get_manifest(url):
    """Serverseitiger Abruf ohne Browser-Cookies/Origin/Referer."""
    req = urllib.request.Request(url, headers={
        'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
        'Accept': '*/*',
    })
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            status = resp.status
            if status != 200:
                return None, status
            data = resp.read(200_000).decode('utf-8-sig', 'replace')
            return (data if data.lstrip().startswith('#EXTM3U') else None), status
    except urllib.error.HTTPError as exc:
        return None, exc.code
    except (urllib.error.URLError, TimeoutError):
        return None, None


def hls_resolve(base, relative):
    """Relative HLS-Pfade verbinden, ohne ein fuehrendes //S2/ zu normalisieren."""
    if relative.startswith('https://'):
        return relative
    if relative.startswith('//'):
        return 'https:' + relative
    b = urllib.parse.urlsplit(base)
    p = urllib.parse.urlsplit(relative)
    if p.path.startswith('/'):
        path = p.path
    else:
        path = b.path.rsplit('/', 1)[0] + '/' + p.path
    return urllib.parse.urlunsplit((b.scheme, b.netloc, path, p.query, p.fragment))


def probe_media(url):
    """Prueft die Media-Playlist und einen Segmentabruf ohne Browser-Cookies."""
    text, code = get_manifest(url)
    if text is None:
        return False, code
    lines = [s.strip() for s in text.splitlines() if s.strip()]
    if '#EXT-X-STREAM-INF' in text:
        for i, line in enumerate(lines[:-1]):
            if line.startswith('#EXT-X-STREAM-INF') and not lines[i + 1].startswith('#'):
                variant = hls_resolve(url, lines[i + 1])
                if not variant.startswith('https://live.duhnet.tv/'):
                    return False, code
                return probe_media(variant)
        return False, code
    if '#EXTINF:' not in text:
        return False, code
    # Ein 200 fuer das Manifest allein beweist noch keine Video-Wiedergabe.
    fragments = [line for line in lines if not line.startswith('#')]
    if not fragments:
        return False, code
    fragment = hls_resolve(url, fragments[0])
    if urllib.parse.urlsplit(fragment).scheme != 'https':
        return False, code
    if urllib.parse.urlsplit(fragment).hostname != 'live.duhnet.tv':
        return False, code
    req = urllib.request.Request(fragment, headers={
        'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20',
        'Range': 'bytes=0-127',
    })
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            # Nur die ersten Bytes lesen, niemals den gesamten Livestream laden.
            response.read(128)
            return response.status in (200, 206), response.status
    except urllib.error.HTTPError as exc:
        return False, exc.code
    except (urllib.error.URLError, TimeoutError):
        return False, None


def is_target_track(url):
    """Die gewuenschte Qualitaet muss wirklich in der URL stehen."""
    return f'/{TARGET_TRACK}/playlist.m3u8' in urllib.parse.urlsplit(url).path


def advertised_target_variants(url):
    """Liest nur vom Server tatsaechlich angebotene Varianten; keine URL-Manipulation."""
    if '/track_' in urllib.parse.urlsplit(url).path:
        return []
    manifest, status = get_manifest(url)
    print('Master-Playlist extern geprueft:', status if status is not None else 'Netzwerkfehler')
    if not manifest or '#EXT-X-STREAM-INF' not in manifest:
        return []
    lines = [s.strip() for s in manifest.splitlines() if s.strip()]
    out = []
    for i, line in enumerate(lines[:-1]):
        if line.startswith('#EXT-X-STREAM-INF') and not lines[i + 1].startswith('#'):
            variant = hls_resolve(url, lines[i + 1])
            if is_target_track(variant) and is_allowed(variant) and variant not in out:
                out.append(variant)
    return out


def detect():
    candidates = []
    page_status = None
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=['--autoplay-policy=no-user-gesture-required'])
        try:
            context = browser.new_context(locale='tr-TR')
            page = context.new_page()

            def on_response(response):
                if response.status == 200 and is_allowed(response.url) and response.url not in candidates:
                    candidates.append(response.url)

            page.on('response', on_response)
            response = page.goto(SOURCE, wait_until='domcontentloaded', timeout=25_000)
            page_status = response.status if response else None
            page.wait_for_timeout(4000)
            if not candidates:
                for selector in ('.vjs-big-play-button', '.jw-display-icon-container',
                                 '.plyr__control--overlaid', 'button[aria-label="Play"]',
                                 'button[aria-label="Oynat"]'):
                    try:
                        button = page.locator(selector).first
                        if button.is_visible(timeout=500):
                            button.click(timeout=2000)
                            break
                    except Exception:
                        pass
                page.wait_for_timeout(8500)
            context.close()
        finally:
            browser.close()
    # Wichtig: nicht wie vorher die zuerst gesehene niedrige Qualitaet speichern.
    print('Erkannte Qualitaets-Playlists:',
          sorted({re.search(r'track_\d+_\d+', urllib.parse.urlsplit(u).path).group(0)
                  for u in candidates if re.search(r'track_\d+_\d+', urllib.parse.urlsplit(u).path)}))
    preferred = [u for u in candidates if is_target_track(u)]
    if not preferred:
        for master in (u for u in candidates if '/track_' not in urllib.parse.urlsplit(u).path):
            for u in advertised_target_variants(master):
                if u not in preferred:
                    preferred.append(u)
    return preferred, page_status


def send(url=None):
    if len(TOKEN) < 24 or not WORKER_URL.startswith('https://'):
        sys.exit('SYNC_TOKEN im neuen GitHub-Repository oder WORKER_URL fehlt.')
    if urllib.parse.urlsplit(WORKER_URL).hostname != 'cnn-turk-browser-test.54xsai54.workers.dev':
        sys.exit('Unerwartetes Worker-Ziel')
    payload = json.dumps({'ok': bool(url), 'url': url}).encode('utf-8')
    req = urllib.request.Request(WORKER_URL + '/internal/sync', data=payload, method='POST', headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + TOKEN,
        'User-Agent': 'CNNturk-GitHub-Refresh/3.0',
    })
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            result = json.load(response)
        if not result.get('ok'):
            raise RuntimeError('Synchronisierung vom Worker abgelehnt')
        print('Cloudflare synchronisiert:', bool(result.get('stored')))
    except urllib.error.HTTPError as error:
        # Keine Response-Bodies dumpen (sie koennten Tokens enthalten).
        raise RuntimeError(f'Cloudflare-Antwort HTTP {error.code}') from None


def main():
    print('CNN Turk: starte Live-Test mit GitHub Chromium.')
    try:
        urls, page_code = detect()
    except Exception as error:
        # Exception kann eine signierte URL enthalten; deshalb nur Typ ausgeben.
        print('Browser-Fehler:', type(error).__name__)
        send(None)
        sys.exit(1)
    print('Seiten-HTTP:', page_code, '| Zielvariante:', TARGET_TRACK, '| Kandidaten:', len(urls))
    usable = None
    for url in urls[:6]:
        ok, status = probe_media(url)
        print('Unabhaengiger Test von ' + TARGET_TRACK + ':', status if status is not None else 'Netzwerkfehler', 'inkl. Segment erfolgreich:', ok)
        if ok:
            usable = url
            break
    send(usable)
    if not usable:
        sys.exit('Die Qualitaet track_3_754 wurde nicht gefunden oder extern mit 403 abgelehnt. Kein neuer Link veroeffentlicht.')
    print('CNN Turk HLS: Adresse uebertragen (keine Fernseh-Wiedergabegarantie).')


if __name__ == '__main__':
    main()
