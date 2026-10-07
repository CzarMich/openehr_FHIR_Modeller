import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { execute, EngineError, OPERATIONS } from './engine.mjs';
import { TOOL_VERSIONS } from './lib/tooling.mjs';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { checkToolReadiness } from './lib/readiness.mjs';

export function createServer({token=process.env.FHIR_ENGINE_TOKEN_FILE ? readFileSync(process.env.FHIR_ENGINE_TOKEN_FILE,'utf8').trim() : process.env.FHIR_ENGINE_TOKEN,context={}}={}) {
  if(!token||token.length<32)throw Error('FHIR_ENGINE_TOKEN must be at least 32 characters.');
  // Tool checks and the 200 MB validator hash run once per process, not per poll.
  const readiness=checkToolReadiness();
  let active=0;
  const server=http.createServer(async(req,res)=>{
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    if(req.method==='GET'&&req.url==='/health'){const ready=await readiness;send(ready.toolsReady?200:503,{status:ready.toolsReady?'ok':'unavailable',standard:'FHIR',role:'private-authoring-and-validation-engine',tools:TOOL_VERSIONS,...ready});return;}
    if(req.method!=='POST'||req.url!=='/execute'){send(404,{error:{code:'NOT_FOUND',message:'Not found.'}});return;}
    const expected=Buffer.from(`Bearer ${token}`),actual=Buffer.from(req.headers.authorization || '');
    if(expected.length!==actual.length||!timingSafeEqual(expected,actual)){send(401,{error:{code:'UNAUTHORIZED',message:'Engine authentication required.'}});return;}
    if(!req.headers['content-type']?.startsWith('application/json')){send(415,{error:{code:'CONTENT_TYPE',message:'Use application/json.'}});return;}
    if(active>=2){send(429,{error:{code:'ENGINE_BUSY',message:'Two FHIR jobs are already running; retry later.'}});return;}
    active++;
    try {
      let size=0;const parts=[];
      for await(const chunk of req){size+=chunk.length;if(size>12_000_000)throw new EngineError('REQUEST_SIZE','Request exceeds 12 MB.',413);parts.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new EngineError('INVALID_JSON','Invalid request JSON.');}
      if(!body||Object.keys(body).some(k=>!['operation','parameters','tenant'].includes(k)))throw new EngineError('REQUEST','Request accepts operation, parameters and tenant only.');
      const result=await execute(body.operation,body.parameters,{...context,tenant:body.tenant});send(200,result);
    } catch(error) {send(error instanceof EngineError?error.status:500,{error:{code:error.code || 'ENGINE_FAILURE',message:error instanceof EngineError?error.message:'FHIR engine execution failed; inspect private service logs.'}});if(!(error instanceof EngineError))console.error('FHIR engine failure:',error.name,error.message);}
    finally{active--;}
  });
  server.requestTimeout=30_000;server.headersTimeout=15_000;server.keepAliveTimeout=5000;
  return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url))createServer().listen(Number(process.env.PORT || 8094),'0.0.0.0',()=>console.log(`Private FHIR engine listening; ${OPERATIONS.length} operations.`));
