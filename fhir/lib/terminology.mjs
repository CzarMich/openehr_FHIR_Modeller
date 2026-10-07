import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { approvedURL } from './network.mjs';
import { fail } from './common.mjs';

// This loopback bridge keeps deployment-owned credentials out of Java command
// arguments, child environments, diagnostic output and project/model parameters.
export async function terminologyBridge() {
  const configured=process.env.FHIR_TERMINOLOGY_URL;
  if(!configured)return null;
  const target=approvedURL(configured,{allowedOrigins:(process.env.FHIR_TERMINOLOGY_ORIGINS || '').split(',')});
  if(target.search)fail('TERMINOLOGY_URL','Terminology URL cannot contain credentials or query parameters.');
  const token=process.env.FHIR_TERMINOLOGY_TOKEN_FILE?(await readFile(process.env.FHIR_TERMINOLOGY_TOKEN_FILE,'utf8')).trim():'';
  let unavailable=false;
  const server=http.createServer(async(req,res)=>{
    // Java is confined to this bridge. It cannot turn the bridge into an open proxy.
    const request=new URL(req.url,'http://127.0.0.1');
    if(!['GET','POST'].includes(req.method)||!/^\/(?:metadata|ValueSet(?:\/\$[A-Za-z-]+)?|CodeSystem(?:\/\$[A-Za-z-]+)?|ConceptMap(?:\/\$[A-Za-z-]+)?|\$[A-Za-z-]+)?$/.test(request.pathname)){res.writeHead(403).end();return;}
    let bytes=0;const parts=[];
    for await(const data of req){bytes+=data.length;if(bytes>5_000_000){res.writeHead(413).end();return;}parts.push(data);}
    const url=new URL(target);url.pathname=target.pathname.replace(/\/$/,'')+request.pathname;url.search=request.search;
    const headers={accept:'application/fhir+json',...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),...(token?{authorization:`Bearer ${token}`}:{})};
    const upstream=https.request(url,{method:req.method,headers,timeout:30_000},response=>{
      if(response.statusCode>=300&&response.statusCode<400){unavailable=true;response.resume();res.writeHead(502).end();return;}
      if(response.statusCode>=500)unavailable=true;
      res.writeHead(response.statusCode,{'content-type':response.headers['content-type'] || 'application/fhir+json'});
      let size=0;response.on('data',data=>{size+=data.length;if(size>20_000_000){unavailable=true;upstream.destroy();res.destroy();}else res.write(data);});response.on('end',()=>res.end());response.on('error',()=>{unavailable=true;res.destroy();});
    });
    upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{unavailable=true;if(!res.headersSent)res.writeHead(502);res.end();});
    upstream.end(Buffer.concat(parts));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  return {url:`http://127.0.0.1:${port}`,socket:`127.0.0.1:${port}`,unavailable:()=>unavailable,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
export function javaPolicy(socket) {
  return `grant {\npermission java.io.FilePermission "<<ALL FILES>>", "read,write,delete,execute";\npermission java.lang.RuntimePermission "*";\npermission java.util.PropertyPermission "*", "read,write";\npermission java.lang.reflect.ReflectPermission "*";\npermission java.security.SecurityPermission "*";\npermission java.net.NetPermission "*";\npermission java.util.logging.LoggingPermission "control";\npermission java.lang.management.ManagementPermission "monitor";\n${socket?`permission java.net.SocketPermission "${socket}", "connect,resolve";`:''}\n};\n`;
}
