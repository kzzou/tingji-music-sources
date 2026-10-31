// Restricted LX bridge probe. Original source and Android preload are executed unchanged.
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), crypto=require('node:crypto');
const {safeURL,checkDNS}=require('./network.cjs');
const root=path.resolve(__dirname,'..');
if(process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') throw Error('Source execution requires an isolated CI validator with no publishing credentials');
const [file,platform='kg',mode='modern',fixtureName='fixtures/kg.json']=process.argv.slice(2);
const raw=fs.readFileSync(path.resolve(file),'utf8');
const report={file,platform,mode,started:new Date().toISOString(),sha256:crypto.createHash('sha256').update(raw).digest('hex'),requests:[],resolves:[]};
const clean=s=>String(s??'').replace(/https?:\/\/[^\s"'<>]+/g,'[URL]').replace(/(token|cookie|authorization|key)\s*[:=]\s*[^\s,;]+/ig,'$1=[redacted]').slice(0,600);
const timers=new Set(),controllers=new Map(); let ctx,ended=false,requestCount=0;
function call(action,data){if(ended)return;ctx.__bridgeData=JSON.stringify(data);try{vm.runInContext(`__lx_native__('probe',${JSON.stringify(action)},__bridgeData)`,ctx,{timeout:1000});}catch(e){report.runtimeError=clean(e.message);}delete ctx.__bridgeData;}
async function limited(url,opt={},cap=262144,entry={}){
 let u=safeURL(url); const c=new AbortController();const timer=setTimeout(()=>c.abort(),Math.min(opt.timeout||13000,15000));controllers.set(entry,c);
 try{
  const headers={Accept:'application/json','User-Agent':'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',...opt.headers};
  let body=opt.body;const method=(opt.method||'GET').toUpperCase();
  if(method==='POST'){
   if(opt.form){body=new URLSearchParams(opt.form).toString();headers['Content-Type']||='application/x-www-form-urlencoded';}
   else if(opt.formData){throw Error('multipart harness unsupported');}
   else headers['Content-Type']||='application/json';
  }
  if(headers['Content-Type']==='application/json'&&body)body=JSON.stringify(body);
  let response;
  for(let i=0;i<5;i++){
   await checkDNS(u);
   response=await fetch(u,{method,headers,body,credentials:'omit',redirect:'manual',signal:c.signal});
   if(![301,302,303,307,308].includes(response.status)||!response.headers.get('location'))break;
   const target=safeURL(new URL(response.headers.get('location'),u).href);await response.body?.cancel();u=target;
  }
  entry.status=response.status;entry.contentType=response.headers.get('content-type')||'';entry.finalHost=u.hostname;
  const parts=[];let n=0;const reader=response.body?.getReader();
  if(reader)try{while(n<cap){const v=await reader.read();if(v.done)break;const b=v.value.subarray(0,cap-n);parts.push(Buffer.from(b));n+=b.length;}}finally{await reader.cancel().catch(()=>{});}
  entry.bytes=n;return {bytes:Buffer.concat(parts),statusCode:response.status,statusMessage:response.statusText,headers:Object.fromEntries(response.headers),url:response.url,ok:response.ok};
 }catch(e){entry.error=clean(e.message+(e.cause?.code?' '+e.cause.code:''));throw e;}finally{clearTimeout(timer);controllers.delete(entry);}
}
async function request(data){
 const e={host:'invalid',method:data.options?.method||'get'};try{const u=safeURL(data.url);e.host=u.hostname;e.path=u.pathname.replace(/[A-Za-z0-9_-]{55,}/g,'[long-id]');e.missingId=/undefined|null|__(?:undefined|null)/.test(decodeURIComponent(data.url));}catch{}
 report.requests.push(e);
 if(++requestCount>24){call('response',{requestKey:data.requestKey,error:'diagnostic request cap'});return;}
 try{const r=await limited(data.url,data.options||{},262144,e);let body=r.bytes.toString('utf8');if(data.options?.binary)body={type:'Buffer',data:[...r.bytes]};else try{body=JSON.parse(body);}catch{}
  if(body&&typeof body==='object'&&!Array.isArray(body))e.apiSummary=Object.fromEntries(Object.entries(body).filter(([k,v])=>/^(code|message|msg|error|status)$/.test(k)&&['string','number','boolean'].includes(typeof v)).map(([k,v])=>[k,clean(v)]));
  delete r.bytes;call('response',{requestKey:data.requestKey,error:null,response:{...r,body}});
 }catch(e2){call('response',{requestKey:data.requestKey,error:clean(e2.message)});}
}
const host={
 __lx_native_call__(_key,action,text){const d=JSON.parse(text);if(action==='request')void request(d);else if(action==='init')report.init=d;else if(action==='response')report.resolves.push(d);else if(action==='showUpdateAlert')report.updateAlert=clean(d.log);},
 __lx_native_call__set_timeout(id,ms){const t=setTimeout(()=>{timers.delete(t);call('__set_timeout__',id)},Math.min(ms,60000));timers.add(t);},
 __lx_native_call__utils_str2b64(s){return Buffer.from(s,'utf8').toString('base64')},
 __lx_native_call__utils_b642buf(s){return JSON.stringify([...Buffer.from(s,'base64')])},
 __lx_native_call__utils_str2md5(s){return crypto.createHash('md5').update(decodeURIComponent(s)).digest('hex')},
 __lx_native_call__utils_aes_encrypt(s,k,iv,alg){try{const key=Buffer.from(k,'base64'), cipher=crypto.createCipheriv(alg==='AES'?'aes-128-ecb':'aes-128-cbc',key,alg==='AES'?null:Buffer.from(iv,'base64'));return Buffer.concat([cipher.update(Buffer.from(s,'base64')),cipher.final()]).toString('base64')}catch{return ''}},
 __lx_native_call__utils_rsa_encrypt(s,k){try{return crypto.publicEncrypt({key:'-----BEGIN PUBLIC KEY-----\n'+k+'\n-----END PUBLIC KEY-----',padding:crypto.constants.RSA_NO_PADDING},Buffer.from(s,'base64')).toString('base64')}catch{return ''}},
};
// Host bridge functions are removed by the preload before any downloaded script executes.
for(const fn of Object.values(host))Object.setPrototypeOf(fn,null);
ctx=vm.createContext(host,{codeGeneration:{strings:false,wasm:false}});
vm.runInContext('globalThis.console={log(){},warn(){},error(){},info(){},debug(){},group(){},groupEnd(){},table(){}}',ctx);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function kind(b){const s=b.toString('utf8').trimStart();if(/^[{[]/.test(s))return'JSON';if(/^<(?:!doctype|html|head|body|\?xml)/i.test(s))return'HTML/XML';if(s.startsWith('#EXTM3U'))return'HLS';if(b.subarray(0,3).toString()==='ID3'||b[0]===255&&(b[1]&224)===224)return'MP3/AAC';if(b.subarray(0,4).toString()==='fLaC')return'FLAC';if(b.subarray(0,4).toString()==='OggS')return'OGG';if(b.subarray(0,4).toString()==='RIFF')return'WAV';if(b.subarray(4,8).toString()==='ftyp')return'MP4/M4A';return'unknown';}
async function main(){
 try{vm.runInContext(fs.readFileSync(path.join(root,'lib/user-api-preload.js'),'utf8'),ctx,{timeout:2000});
  const header=raw.match(/^\s*\/\*[^]*?\*\//)?.[0]||'';const meta={};for(const key of ['name','description','version','author','homepage'])meta[key]=(header.match(new RegExp('@'+key+' +([^\\r\\n]+)'))?.[1]||'').trim();report.metadata=meta;
  ctx.__raw=raw;vm.runInContext(`lx_setup('probe','diagnostic',${['name','description','version','author','homepage'].map(k=>JSON.stringify(meta[k])).join(',')},__raw);delete globalThis.__raw`,ctx,{timeout:2000});
  vm.runInContext(raw,ctx,{timeout:3000,filename:file});
  const end=Date.now()+10000;while(!report.init&&Date.now()<end&&!report.runtimeError)await wait(50);
  if(!report.init)report.initError='no initialization within 10 seconds';
  if(platform&&report.init?.status){
   const fixtures=JSON.parse(fs.readFileSync(path.join(root,fixtureName),'utf8'));const row=fixtures.fixtures?.find(f=>f.source===platform);const fixture=fixtures[platform]||(row?{modern:row.musicInfo,legacy:row.legacy}:null);
   const capability=report.init.info.sources[platform];
   if(!capability?.actions.includes('musicUrl')||!capability.qualitys.length)report.skipped='platform/quality not advertised';
   else if(!fixture?.modern)report.skipped='no verified song fixture';
   else{
    const musicInfo=mode==='legacy'?fixture.legacy:fixture.modern;
    report.sample={name:musicInfo.name,singer:musicInfo.singer,songId:fixture.modern.meta.songId};report.quality='128k';if(!capability.qualitys.includes('128k')) throw Error('128k capability absent');
    call('request',{requestKey:'sample',data:{source:platform,action:'musicUrl',info:{type:report.quality,musicInfo}}});
    const end=Date.now()+20000;while(!report.resolves.length&&Date.now()<end&&!report.runtimeError)await wait(50);
    if(!report.resolves.length)report.resolveError='20-second app timeout';
    else{const r=report.resolves[0];if(r.status){const url=r.result?.data?.url;if(url){report.media={host:safeURL(url).hostname};try{const b=await limited(url,{headers:{Range:'bytes=0-8191'}},8192,report.media);report.media.kind=kind(b.bytes);report.media.audioHeader=/^(MP3|FLAC|OGG|WAV|MP4)/.test(report.media.kind);}catch(e){report.media.error=clean(e.message);}delete r.result.data.url;}}else r.errorMessage=clean(r.errorMessage);}
   }
  }
 }catch(e){report.runtimeError=clean(e.message);}
 ended=true;for(const t of timers)clearTimeout(t);for(const c of controllers.values())c.abort();
 report.finished=new Date().toISOString();delete report.updateAlert;
 process.stdout.write(JSON.stringify(report)+'\n');
}
process.on('unhandledRejection',e=>{report.unhandledRejection=clean(e?.message||e)});
main().then(()=>process.exit(0));
