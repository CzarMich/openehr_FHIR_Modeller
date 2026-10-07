// Isolated HTTPS contract fixture, never part of the production image.
import https from 'node:https';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
const heads = new Map(), files = new Map();
const columns = [
  {name:'ModelProjectId', text:{}, indexed:true, enforceUniqueValues:true},
  {name:'SnapshotItemId', text:{}}, {name:'SnapshotHash', text:{}},
];
const server = https.createServer({key:fs.readFileSync('/fixture-data/tls.key'), cert:fs.readFileSync('/fixture-data/tls.crt')}, async (req,res) => {
  const respond = (status, body = {}) => {res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  try {
    const url = new URL(req.url, 'https://sharepoint-fixture'), path = decodeURIComponent(url.pathname);
    const chunks = []; let size = 0;
    for await (const chunk of req) {size += chunk.length;if(size > 8388608){respond(413);return;}chunks.push(chunk);}
    const content = Buffer.concat(chunks).toString('utf8');
    if(path === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(content);
      if(form.get('client_id') !== 'fixture-client' || form.get('client_secret') !== 'fixture-secret' || form.get('grant_type') !== 'client_credentials') {respond(401);return;}
      respond(200, {access_token:'fixture-token',token_type:'Bearer',expires_in:3600});return;
    }
    if(path.startsWith('/download/')) {
      if(req.headers.authorization || req.headers.cookie){respond(403);return;}
      const item = files.get(path.slice('/download/'.length));
      if(!item){respond(404);return;}res.writeHead(200, {'Content-Type':'application/json'});res.end(item);return;
    }
    if(req.headers.authorization !== 'Bearer fixture-token'){respond(401);return;}
    if(path === '/v1.0/sites/site/lists/list/columns' && req.method === 'GET'){respond(200,{value:columns});return;}
    if(path === '/v1.0/sites/site/lists/list/items') {
      if(req.method === 'GET') {
        let rows = [...heads.values()];const filter = url.searchParams.get('$filter');
        if(filter){const match = /^fields\/ModelProjectId eq '([A-Za-z0-9_-]+)'$/.exec(filter);if(!match){respond(400);return;}rows=rows.filter(r=>r.fields.ModelProjectId===match[1]);}
        respond(200,{value:rows});return;
      }
      if(req.method === 'POST') {
        const {fields} = JSON.parse(content);
        if([...heads.values()].some(row=>row.fields.ModelProjectId===fields.ModelProjectId)){respond(400);return;}
        const id = String(heads.size+1), row = {id,eTag:'"1"',fields};heads.set(id,row);respond(201,row);return;
      }
    }
    let match = /^\/v1.0\/sites\/site\/lists\/list\/items\/([0-9]+)\/fields$/.exec(path);
    if(match && req.method === 'PATCH') {
      const row = heads.get(match[1]);if(!row){respond(404);return;}
      if(req.headers['if-match'] !== row.eTag){respond(412);return;}
      row.fields = {...row.fields,...JSON.parse(content)};row.eTag='"'+(Number(row.eTag.replaceAll('"',''))+1)+'"';respond(200,row.fields);return;
    }
    match = /^\/v1.0\/drives\/drive\/items\/folder:\/snapshot-[a-f0-9]{48}\.json:\/content$/.exec(path);
    if(match && req.method === 'PUT'){const id=randomBytes(16).toString('hex');files.set(id,content);respond(201,{id});return;}
    match = /^\/v1.0\/drives\/drive\/items\/([a-f0-9]{32})(\/content)?$/.exec(path);
    if(match && req.method === 'GET') {
      const item = files.get(match[1]);if(!item){respond(404);return;}
      if(match[2]){res.writeHead(302,{Location:'https://sharepoint-fixture/download/'+match[1]+'?opaque=fixture'});res.end();return;}
      respond(200,{id:match[1],size:Buffer.byteLength(item),file:{},parentReference:{id:'folder'}});return;
    }
    respond(404);
  } catch {respond(500);}
});
server.listen(443,'0.0.0.0',()=>fs.writeFileSync('/fixture-data/ready','ready'));
