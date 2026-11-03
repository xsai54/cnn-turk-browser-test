/** CNN Türk Master-Link V4: Chrome führt Originalabruf durch, Worker hält nur die aktuelle Adresse. */
const LIVE_KEY='cnn-turk:chrome-approved:v4';
const LEGACY_KEY='cnn-turk:github-refresh:v3';
const MAX_AGE_MS=2*60*60*1000;
const MIN_REMAINING_MS=60*1000;
const noStore={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex'};
function respondJson(v,status=200,extra={}) {return new Response(JSON.stringify(v,null,2),{status,headers:{...noStore,'Content-Type':'application/json; charset=utf-8',...extra}})}
function checkUrl(raw,now=Date.now()) {
 if(typeof raw!=='string'||raw.length>4096||!raw.startsWith('https://'))return null;
 try{
 const url=new URL(raw);
 if(url.protocol!=='https:'||url.hostname!=='live.duhnet.tv'||url.username||url.password||url.port)return null;
 if(!/^\/{1,2}S2\/HLS_LIVE\/cnnturknp\/(?:track_[\w-]+\/)?playlist\.m3u8$/i.test(url.pathname))return null;
 const expiry=Number(url.searchParams.get('e'));
 if(!Number.isSafeInteger(expiry)||!url.searchParams.get('st')||expiry*1000<=now+MIN_REMAINING_MS)return null;
 if(expiry*1000>now+7*24*60*60*1000)return null;
 return {url:raw,expiry}; // Do NOT normalize or rewrite the signed string
 }catch{return null}
}
function isReady(s,now=Date.now()){
 const date=Date.parse(s?.updatedAt||'');return Boolean(s?.url&&Number.isFinite(date)&&date<=now&&now-date<MAX_AGE_MS&&checkUrl(s.url,now));
}
function secretOk(request,env){const expected=env.SYNC_TOKEN;return typeof expected==='string'&&expected.length>=24&&request.headers.get('Authorization')==='Bearer '+expected}
function cors(req){const origin=req.headers.get('Origin');return origin==='null'||origin==='https://cnn-turk-browser-test.54xsai54.workers.dev'?{
 'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'Authorization, Content-Type',
 'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Max-Age':'600','Vary':'Origin'
}:{} }
function response404(){return new Response('Nicht gefunden',{status:404,headers:noStore})}
async function record(env){if(!env.STREAMS_KV)throw Error('STREAMS_KV fehlt');return env.STREAMS_KV.get(LIVE_KEY,{type:'json'})}
const MANAGER_HTML="<!doctype html>\n<html lang=\"de\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>CNN Türk · Master-Link Updater</title>\n<style>\n:root{font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#182332;background:#f3f6fa}*{box-sizing:border-box}\nmain{max-width:850px;margin:36px auto;padding:0 16px}h1{margin:0;font-size:29px}p{line-height:1.55}.sub{color:#58677b;margin-top:6px}\nsection{background:white;padding:22px;margin:18px 0;border:1px solid #dce5ef;border-radius:15px;box-shadow:0 2px 12px #1a36520b}\nlabel{font-weight:650;display:block;margin:14px 0 7px}input[type=password],textarea{width:100%;padding:13px 14px;border:1px solid #bccbdc;border-radius:9px;font:inherit}\ntextarea{resize:vertical;min-height:64px;font-size:12px}button{border:0;border-radius:9px;padding:12px 16px;font:inherit;font-weight:650;cursor:pointer;background:#1570ef;color:#fff;margin:4px 5px 4px 0}\nbutton.secondary{background:#e8eef6;color:#172638}button:disabled{opacity:.5;cursor:wait}code{overflow-wrap:anywhere;font-size:12px}\n.notice{background:#eff6ff;border-left:4px solid #1570ef;padding:11px 13px;border-radius:6px;color:#2e4a6c;font-size:14px}\n.warn{background:#fff7ed;border-color:#f59e0b}.status{margin-top:12px;border-radius:8px;padding:13px;background:#edf1f5;white-space:pre-wrap;font-size:14px;line-height:1.5}\n.good{background:#eaf8f1;color:#16633c}.bad{background:#fff0ed;color:#922b26}small{font-size:13px;color:#56677c}.switch{display:flex;align-items:center;gap:9px;margin-top:8px}\n@media(max-width:600px){main{margin:16px auto}section{padding:17px}h1{font-size:23px}}\n</style></head><body><main>\n<h1>CNN Türk · Master-Link Updater</h1>\n<p class=\"sub\">Der Abruf erfolgt direkt in deinem Chrome-Browser – nicht auf einem GitHub- oder Cloudflare-Server.</p>\n<section><h2>1. Dein fester IPTV-Link</h2><p>Diese Adresse bleibt für den Fernseher immer gleich:</p>\n<div class=\"notice\"><code id=\"master\">https://cnn-turk-browser-test.54xsai54.workers.dev/cnn-turk.m3u8</code></div>\n<button type=\"button\" class=\"secondary\" id=\"copyMaster\">Master-Link kopieren</button><button type=\"button\" class=\"secondary\" id=\"check\">Speicherstatus prüfen</button>\n<div id=\"storageStatus\" class=\"status\">Noch nicht geprüft.</div></section>\n<section><h2>2. Aktuellen Original-Link holen und speichern</h2>\n<label for=\"key\">Dein bestehender SYNC_TOKEN aus GitHub/Cloudflare</label>\n<input type=\"password\" id=\"key\" placeholder=\"Geheimschlüssel einfügen\" autocomplete=\"off\" spellcheck=\"false\">\n<p><small>Der Schlüssel wird nicht in der HTML-Datei, Cookies oder im Browser-Speicher abgelegt. Er wird nur an deinen eigenen Cloudflare-Worker gesendet.</small></p>\n<button type=\"button\" id=\"refresh\">Jetzt direkt aus Chrome aktualisieren</button>\n<label class=\"switch\"><input id=\"auto\" type=\"checkbox\"> Automatisch etwa alle 8 Minuten aktualisieren, solange diese Seite geöffnet ist</label>\n<div id=\"progress\" class=\"status\">Bereit. Noch kein Abruf gestartet.</div>\n<p class=\"notice warn\">Wichtig: Bei geschlossenem Chrome, ausgeschaltetem PC oder einem gedrosselten Hintergrund-Tab kann keine Aktualisierung erfolgen. Der feste IPTV-Link funktioniert nur, solange die gespeicherte Originaladresse vom Sender akzeptiert wird.</p>\n</section>\n<section><h2>3. Notfall: Original-Link selbst einfügen</h2>\n<p class=\"sub\">Falls der direkte API-Abruf nicht funktioniert, kopiere den funktionierenden CNN-Türk-Link aus Chrome und füge ihn hier ein.</p>\n<textarea id=\"manual\" placeholder=\"https://live.duhnet.tv//S2/HLS_LIVE/.../playlist.m3u8?...\" spellcheck=\"false\"></textarea>\n<button type=\"button\" class=\"secondary\" id=\"publishManual\">Diesen Original-Link speichern</button>\n<p><small>Keine festen Tokens im Quellcode. Die Originaladresse bleibt unverändert, einschließlich <code>//S2/</code>, <code>st</code> und <code>e</code>.</small></p>\n</section>\n</main><script>\n(()=>{'use strict';\nconst WORKER='https://cnn-turk-browser-test.54xsai54.workers.dev';\nconst API='https://www.cnnturk.com/api/cnnvideo/media?id=62d6814670380e2cdc7c124c&isMobile=false';\nconst $=id=>document.getElementById(id);\nlet working=false, timer=null, lastUrl='';\nfunction state(message,type=''){const el=$('progress');el.textContent=message;el.className='status '+type}\nfunction validate(raw){\n const u=new URL(raw.trim());\n if(u.protocol!=='https:' || u.hostname!=='live.duhnet.tv' || u.username || u.password || u.port) throw Error('Nur die offizielle live.duhnet.tv-Adresse ist erlaubt.');\n if(!/^\/{1,2}S2\/HLS_LIVE\/cnnturknp\/(?:track_[\w-]+\/)?playlist\.m3u8$/i.test(u.pathname)) throw Error('Der CNN-Türk-M3U8-Pfad ist ungültig.');\n const expire=Number(u.searchParams.get('e'));\n if(!u.searchParams.get('st') || !Number.isSafeInteger(expire) || expire*1000<Date.now()+90000) throw Error('Der signierte Original-Link ist bereits abgelaufen oder unvollständig.');\n return u.href;\n}\nfunction fromApi(j){\n const link=j?.Media?.Link ?? j?.media?.link;\n const secure=link?.SecurePath?.trim();const service=(link?.ServiceUrl||link?.DefaultServiceUrl||'').trim();\n if(!secure || !service) throw Error('SecurePath oder ServiceUrl fehlt in der CNN-Türk-Antwort.');\n const base=new URL(service);if(base.protocol!=='https:'||base.hostname!=='live.duhnet.tv') throw Error('Unerwarteter Stream-Host');\n const path=secure.startsWith('/')?secure:'/'+secure;\n // Wie im bereits funktionierenden lokalen Test: ein Slash nach dem Host plus SecurePath.\n return validate(base.origin+(path.startsWith('//')?'':'/')+path);\n}\nasync function publish(url){\n const key=$('key').value.trim();if(key.length<24) throw Error('Bitte zuerst den SYNC_TOKEN eingeben (mindestens 24 Zeichen).');\n const result=await fetch(WORKER+'/api/browser-update',{\n   method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},\n   body:JSON.stringify({url}),cache:'no-store',mode:'cors'\n });\n let data;try{data=await result.json()}catch{throw Error('Cloudflare hat keine gültige JSON-Antwort geliefert (HTTP '+result.status+').')}\n if(!result.ok || !data.ok)throw Error('Cloudflare: '+(data.error||'HTTP '+result.status));\n lastUrl=url;\n const u=new URL(url);return 'Cloudflare hat den Browser-Link gespeichert.\nOriginal-Track: '+(u.pathname.match(/track_[^/]+/)||['Master-Playlist'])[0]+'\nGültig bis (laut Sender): '+new Date(Number(u.searchParams.get('e'))*1000).toLocaleString('de-DE')+'\nJetzt Master-Link im IPTV-Player testen.';\n}\nasync function refresh(manual=false){\n if(working)return;working=true;$('refresh').disabled=true;$('publishManual').disabled=true;\n try{\n  let url;\n  if(manual){url=validate($('manual').value);state('Original-Link wird gespeichert …')}\n  else{state('Chrome fragt direkt die offizielle CNN-Türk-API ab …');\n   const r=await fetch(API,{cache:'no-store',credentials:'omit',redirect:'follow'});\n   if(!r.ok)throw Error('CNN-Türk-API: HTTP '+r.status);\n   url=fromApi(await r.json());state('Originaladresse gefunden. Sichere Übertragung an Cloudflare …');\n  }\n  state(await publish(url),'good');await checkStatus();\n }catch(e){state('Abruf nicht abgeschlossen: '+(e?.message||String(e))+'\nBei einem CORS-Problem versuche die lokal gespeicherte HTML-Datei oder füge den Original-Link unten ein.','bad')}\n finally{working=false;$('refresh').disabled=false;$('publishManual').disabled=false}\n}\nasync function checkStatus(){\n try{\n  const r=await fetch(WORKER+'/status',{cache:'no-store'});const d=await r.json();\n  $('storageStatus').textContent=d.ok?'Gültige Adresse vorhanden. Aktualisiert: '+(d.zuletztGespeichert?new Date(d.zuletztGespeichert).toLocaleString('de-DE'):'unbekannt')+'; Ablauf: '+(d.ablauf?new Date(d.ablauf).toLocaleString('de-DE'):'unbekannt'):\n  'Noch keine gültige Browser-Adresse gespeichert. '+(d.hinweis||'');\n  $('storageStatus').className='status '+(d.ok?'good':'bad');\n }catch(e){$('storageStatus').textContent='Statusabruf fehlgeschlagen: '+e.message;$('storageStatus').className='status bad'}\n}\n$('refresh').addEventListener('click',()=>refresh(false));\n$('publishManual').addEventListener('click',()=>refresh(true));\n$('check').addEventListener('click',checkStatus);\n$('copyMaster').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(WORKER+'/cnn-turk.m3u8');$('copyMaster').textContent='Kopiert';setTimeout(()=>{$('copyMaster').textContent='Master-Link kopieren'},1300)}catch{state('Bitte den Link oben manuell kopieren.','bad')}});\n$('auto').addEventListener('change',()=>{if(timer)clearInterval(timer);timer=null;if($('auto').checked){timer=setInterval(()=>{if(!working)refresh(false)},8*60*1000);state('Automatik ist eingeschaltet. Zum sofortigen Start auf „Jetzt aktualisieren“ klicken.')}});\ncheckStatus();\n})();\n</script></body></html>";
export default {
 async fetch(request,env){
  const pathname=new URL(request.url).pathname;
  const method=request.method;
  if(pathname==='/api/browser-update') {
   const origin=request.headers.get('Origin');
   // Only local HTML (Origin: null) or our own hosted Manager page.
   if(origin&&origin!=='null'&&origin!=='https://cnn-turk-browser-test.54xsai54.workers.dev')return respondJson({ok:false,error:'Origin nicht erlaubt'},403);
   const headers=cors(request);
   if(method==='OPTIONS')return new Response(null,{status:204,headers:{...noStore,...headers}});
   if(method!=='POST')return new Response('Method Not Allowed',{status:405,headers:{...noStore,...headers}});
   if(!secretOk(request,env))return respondJson({ok:false,error:'SYNC_TOKEN falsch oder fehlt'},401,headers);
   if(!env.STREAMS_KV)return respondJson({ok:false,error:'KV STREAMS_KV fehlt'},503,headers);
   let body;try{body=await request.json()}catch{return respondJson({ok:false,error:'Ungueltiges JSON'},400,headers)}
   const checked=checkUrl(body?.url);
   if(!checked)return respondJson({ok:false,error:'Originaladresse ungueltig oder abgelaufen'},400,headers);
   const data={url:checked.url,updatedAt:new Date().toISOString(),checkedBy:'Eigenes Chrome – direkter CNN-Tuerk-API-Abruf',lastCheckOk:null};
   try{await env.STREAMS_KV.put(LIVE_KEY,JSON.stringify(data))}catch(e){return respondJson({ok:false,error:'Speichern fehlgeschlagen'},503,headers)}
   return respondJson({ok:true,stored:true,updatedAt:data.updatedAt,expiresAt:new Date(checked.expiry*1000).toISOString(),hinweis:'Original-Link gespeichert; IPTV-Wiedergabe noch nicht bestaetigt'},200,headers);
  }
  // Keep legacy GitHub sync endpoint isolated from the browser-provided channel link.
  if(pathname==='/internal/sync'){
   if(method!=='POST')return new Response('Method Not Allowed',{status:405,headers:noStore});
   if(!secretOk(request,env))return respondJson({ok:false,error:'Nicht autorisiert'},401);
   let b;try{b=await request.json()}catch{return respondJson({ok:false,error:'Ungueltiges JSON'},400)}
   const valid=checkUrl(b?.url);if(b?.ok===true&&valid){
     const s={url:b.url,updatedAt:new Date().toISOString(),checkedBy:'GitHub Chromium',lastCheckOk:true};
     await env.STREAMS_KV.put(LEGACY_KEY,JSON.stringify(s));return respondJson({ok:true,stored:true,source:'github'});
   }
   return respondJson({ok:true,stored:false,source:'github'});
  }
  if(method!=='GET'&&method!=='HEAD')return new Response('Method Not Allowed',{status:405,headers:noStore});
  if(pathname==='/manager'||pathname==='/')return new Response(method==='HEAD'?null:MANAGER_HTML,{status:200,headers:{...noStore,'Content-Type':'text/html; charset=utf-8','X-Frame-Options':'DENY'}});
  if(!['/status','/cnn-turk.m3u8','/cnn-turk.m3u'].includes(pathname))return response404();
  let s;try{s=await record(env)}catch(e){return respondJson({ok:false,error:'KV nicht verbunden'},503)}
  const ready=isReady(s),exp=ready?Number(new URL(s.url).searchParams.get('e')):null;
  if(pathname==='/status')return respondJson({
   ok:ready,quelle:'Direkt vom Chrome-Browser gespeichert, kein Cloud-Browser',
   zuletztGespeichert:s?.updatedAt||null,ablauf:exp?new Date(exp*1000).toISOString():null,
   hinweis:ready?'Aktuelle Originaladresse gespeichert; Wiedergabe noch vom IPTV-Player zu bestaetigen.':'Noch keine gueltige Browser-Adresse gespeichert oder abgelaufen.',
   browserStartsProZuschauer:0,githubWorkflowNichtErforderlich:true
  });
  if(!ready)return new Response('CNN Tuerk: Kein aktuell gueltiger Browser-Link gespeichert. Bitte /manager oeffnen und aktualisieren.',{status:503,headers:{...noStore,'Content-Type':'text/plain; charset=utf-8'}});
  if(pathname==='/cnn-turk.m3u'){
   const master=new URL('/cnn-turk.m3u8',request.url).toString();
   return new Response(method==='HEAD'?null:'#EXTM3U\n#EXTINF:-1 tvg-id="CNNTurk.tr" group-title="Haber",CNN Türk\n'+master+'\n',{status:200,headers:{...noStore,'Content-Type':'audio/x-mpegurl; charset=utf-8'}});
  }
  return new Response(null,{status:302,headers:{...noStore,Location:s.url}});
 }
};
