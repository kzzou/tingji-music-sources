// Restricted LX bridge probe. Original source and Android preload are executed unchanged.
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), crypto=require('node:crypto');
const {safeURL,requestPrefix}=require('./network.cjs');
const root=path.resolve(__dirname,'..');
function selectFixture(fixtures, platform, sampleIndex=0) {
 const legacyRow=fixtures.fixtures?.filter(row=>row.source===platform)[sampleIndex];
 const direct=fixtures[platform];
 const fixture=(Array.isArray(direct)?direct[sampleIndex]:sampleIndex===0?direct:null)||(legacyRow?{modern:legacyRow.musicInfo,legacy:legacyRow.legacy}:null);
 return fixture?.modern?.source===platform&&fixture.modern.meta?.songId!=null?fixture:null;
}
function kind(b){const s=b.toString('utf8').trimStart();if(/^[{[]/.test(s))return'JSON';if(/^<(?:!doctype|html|head|body|\?xml)/i.test(s))return'HTML/XML';if(s.startsWith('#EXTM3U'))return'HLS';if(b.subarray(0,3).toString()==='ID3'||b[0]===255&&(b[1]&224)===224)return'MP3/AAC';if(b.subarray(0,4).toString()==='fLaC')return'FLAC';if(b.subarray(0,4).toString()==='OggS')return'OGG';if(b.subarray(0,4).toString()==='RIFF')return'WAV';if(b.subarray(4,8).toString()==='ftyp')return'MP4/M4A';return'unknown';}
async function runProbe({file,platform='kg',mode='modern',fixtureName='fixtures/platforms.json',sampleIndex}) {
if(process.env.GITHUB_ACTIONS !== 'true' || process.env.CI !== 'true') throw Error('Source execution requires an isolated CI validator with no publishing credentials');
const raw=fs.readFileSync(path.resolve(file),'utf8');
const report={file,platform,mode,started:new Date().toISOString(),sha256:crypto.createHash('sha256').update(raw).digest('hex'),requests:[],resolves:[]};
const responseEvents=[],deadline=Date.now()+44000;
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
   response=await requestPrefix(u,{method,headers,body,limit:cap,signal:c.signal});
   if(![301,302,303,307,308].includes(response.statusCode)||!response.headers.location)break;
   if(i===4)throw Error('too many redirects');
   u=safeURL(new URL(response.headers.location,u).href);
  }
  entry.status=response.statusCode;entry.contentType=response.headers['content-type']||'';entry.finalHost=u.hostname;
  entry.bytes=response.bytes.length;return response;
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
 __lx_native_call__(_key,action,text){const d=JSON.parse(text);if(action==='request')void request(d);else if(action==='init')report.init=d;else if(action==='response')responseEvents.push(d);else if(action==='showUpdateAlert')report.updateAlert=clean(d.log);},
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

async function main(){
 try{vm.runInContext(fs.readFileSync(path.join(root,'lib/user-api-preload.js'),'utf8'),ctx,{timeout:2000});
  const prefix=raw.slice(0,16384);const headerEnd=prefix.indexOf('*/');const header=headerEnd<0?'':prefix.slice(0,headerEnd+2);const meta={};for(const key of ['name','description','version','author','homepage'])meta[key]=(header.match(new RegExp('@'+key+' +([^\\r\\n]+)'))?.[1]||'').trim();report.metadata=meta;
  ctx.__raw=raw;vm.runInContext(`lx_setup('probe','diagnostic',${['name','description','version','author','homepage'].map(k=>JSON.stringify(meta[k])).join(',')},__raw);delete globalThis.__raw`,ctx,{timeout:2000});
  vm.runInContext(raw,ctx,{timeout:3000,filename:file});
  const end=Date.now()+10000;while(!report.init&&Date.now()<end&&!report.runtimeError)await wait(50);
  if(!report.init)report.initError='no initialization within 10 seconds';
  if(platform&&report.init?.status){
   const fixtures=JSON.parse(fs.readFileSync(path.resolve(root,fixtureName),'utf8'));
   const indices=sampleIndex===undefined?[0,1]:[sampleIndex];
   const cases=indices.map(index=>({fixture:selectFixture(fixtures,platform,index),index})).filter(row=>row.fixture?.modern);
   const capability=report.init.info?.sources?.[platform];
   if(!capability?.actions.includes('musicUrl')||!capability.qualitys.length)report.skipped='platform/quality not advertised';
   else if(!cases.length)report.skipped='no verified song fixture';
   else{
    if(!capability.qualitys.includes('128k')) throw Error('128k capability absent');
    report.attempts=[];
    for(const {fixture,index} of cases){
     if(Date.now()>=deadline-500)break;
     const musicInfo=mode==='legacy'?fixture.legacy:fixture.modern;
     const requestKey='sample-'+index;
     const attempt={requestKey,sample:{name:musicInfo.name,singer:musicInfo.singer,songId:fixture.modern.meta.songId,index,requested:fixture.requested===true},quality:'128k',resolves:[]};
     report.attempts.push(attempt);
     call('request',{requestKey,data:{source:platform,action:'musicUrl',info:{type:'128k',musicInfo}}});
     const end=Math.min(Date.now()+17000,deadline-500);
     while(!responseEvents.some(row=>row.requestKey===requestKey)&&Date.now()<end&&!report.runtimeError)await wait(50);
     const response=responseEvents.find(row=>row.requestKey===requestKey);
     if(!response)attempt.resolveError='bounded sample resolution timeout';
     else{
      attempt.resolves=[response];
      if(response.status){
       const url=response.result?.data?.url;
       if(url){
        attempt.media={};
        try{attempt.media.host=safeURL(url).hostname;const b=await limited(url,{headers:{Range:'bytes=0-8191'},timeout:Math.max(1,Math.min(13000,deadline-Date.now()-250))},8192,attempt.media);attempt.media.kind=kind(b.bytes);attempt.media.audioHeader=/^(MP3|FLAC|OGG|WAV|MP4)/.test(attempt.media.kind);}catch(e){attempt.media.error=clean(e.message);}
        delete response.result.data.url;
       }
      }else response.errorMessage=clean(response.errorMessage);
     }
     report.sample=attempt.sample;report.quality=attempt.quality;report.media=attempt.media;
     report.resolves=attempt.resolves.map(row=>({...row,requestKey:'sample'}));
     if(attempt.resolveError)report.resolveError=attempt.resolveError;else delete report.resolveError;
     if(response?.status&&[200,206].includes(attempt.media?.status)&&attempt.media?.bytes>=32&&attempt.media.audioHeader&&!attempt.media.error)break;
    }
   }
  }
 }catch(e){report.runtimeError=clean(e.message);}
 ended=true;for(const t of timers)clearTimeout(t);for(const c of controllers.values())c.abort();
 report.finished=new Date().toISOString();delete report.updateAlert;
}
const unhandled=e=>{report.unhandledRejection=clean(e?.message||e)};
process.on('unhandledRejection',unhandled);
try { await main(); return report; } finally { process.removeListener('unhandledRejection',unhandled); }
}
if(require.main===module){
 const [file,platform='kg',mode='modern',fixtureName='fixtures/platforms.json',sampleIndex='auto']=process.argv.slice(2);
 runProbe({file,platform,mode,fixtureName,sampleIndex:sampleIndex==='auto'?undefined:Number(sampleIndex)}).then(report=>{process.stdout.write(JSON.stringify(report)+'\n');process.exit(0);}).catch(error=>{process.stderr.write(String(error.message)+'\n');process.exit(1);});
}
module.exports={selectFixture,kind,runProbe};
