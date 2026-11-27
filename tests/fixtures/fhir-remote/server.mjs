import https from 'node:https';
import fs from 'node:fs';
const root='/fixture-data';let unexpected=0;
const definition={resourceType:'StructureDefinition',id:'Synthetic',url:'https://example.org/StructureDefinition/Synthetic',version:'1.0.0',name:'Synthetic',type:'Patient',fhirVersion:'4.0.1',status:'draft'};
https.createServer({key:fs.readFileSync(root+'/tls.key'),cert:fs.readFileSync(root+'/tls.crt')},async(req,res)=>{
 const url=new URL(req.url,'https://fhir-remote-fixture');const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
 if(url.pathname==='/ig/api/v1/auth/login'&&req.method==='POST'){const body=JSON.parse(Buffer.concat(chunks));if(body.email!=='fixture@example.org'||body.password!=='synthetic-secret'){send(401,{});return;}send(200,{accessToken:'fixture-ig-token'});return;}
 const ig=url.pathname.startsWith('/ig/');if(req.headers.authorization!==`Bearer ${ig?'fixture-ig-token':'fixture-definition-token'}`){send(401,{});return;}
 if(url.pathname==='/ig/api/v1/admin/health'){send(200,{status:'ok'});return;}
 if(url.pathname==='/ig/api/v1/projects'){send(200,[{id:'00000000-0000-0000-0000-000000000000',name:'Synthetic'}]);return;}
 if(url.pathname==='/metadata'){send(200,{resourceType:'CapabilityStatement',rest:[{mode:'server',operation:[{name:'validate',definition:'http://hl7.org/fhir/OperationDefinition/Resource-validate'}]}]});return;}
 if(url.pathname==='/StructureDefinition'){send(200,{resourceType:'Bundle',type:'searchset',total:2,entry:[{resource:definition}],link:[{relation:'next',url:'https://fhir-remote-fixture/unexpected'}]});return;}
 if(url.pathname==='/StructureDefinition/Synthetic'){res.writeHead(200,{'Content-Type':'application/fhir+json'});res.end(' '+JSON.stringify(definition)+'\n');return;}
 if(url.pathname==='/StructureDefinition/WrongType'){send(200,{resourceType:'Patient',id:'synthetic-not-allowed'});return;}
 if(url.pathname==='/$validate'&&req.method==='POST'){const body=JSON.parse(Buffer.concat(chunks));if(body.resourceType!=='Patient'){send(400,{});return;}send(200,{resourceType:'OperationOutcome',issue:[{severity:'information',code:'informational'}]});return;}
 if(url.pathname==='/stats'){send(200,{unexpected});return;}
 unexpected++;send(404,{});
}).listen(443,'0.0.0.0',()=>fs.writeFileSync(root+'/ready','ready'));
