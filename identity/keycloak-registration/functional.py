#!/usr/bin/env python3
"""Disposable Keycloak registration acceptance; synthetic identities only, no attack/load test."""
import http.cookiejar, json, secrets, ssl, subprocess, tempfile, time, urllib.request, urllib.error, urllib.parse
from html.parser import HTMLParser
from pathlib import Path
BASE="https://127.0.0.1:18443"
tls=tempfile.TemporaryDirectory(prefix="modeller-keycloak-tls-")
tlsdir=Path(tls.name);tlsdir.chmod(0o755)
subprocess.run(["openssl","req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=127.0.0.1","-addext","subjectAltName=IP:127.0.0.1","-keyout",str(tlsdir/"key.pem"),"-out",str(tlsdir/"cert.pem")],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
(tlsdir/"key.pem").chmod(0o644) # Disposable synthetic fixture key, readable by the container UID.
https=urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=str(tlsdir/"cert.pem")))
trusted=urllib.request.build_opener(https)
name="modeller-registration-fixture-"+secrets.token_hex(4)
password=secrets.token_urlsafe(32)
def docker(*args):
    result=subprocess.run(["docker",*args],text=True,capture_output=True)
    if result.returncode: raise RuntimeError("Disposable Docker operation failed with status "+str(result.returncode))
    return result.stdout.strip()
def request(path,method="GET",value=None,token=None):
    data=None if value is None else json.dumps(value).encode()
    req=urllib.request.Request(BASE+path,data=data,method=method,headers={"Content-Type":"application/json",**({"Authorization":"Bearer "+token} if token else {})})
    with trusted.open(req,timeout=15) as res:
        body=res.read();return json.loads(body) if body else None
class Form(HTMLParser):
    action=None
    def __init__(self):
        super().__init__(); self.hidden={}
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=="form" and attrs.get("id")=="kc-register-form": self.action=attrs.get("action")
        if tag=="input" and attrs.get("type")=="hidden" and attrs.get("name"): self.hidden[attrs["name"]]=attrs.get("value","")
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args): return None
def register(email):
    jar=http.cookiejar.CookieJar()
    browser=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar),NoRedirect(),https)
    url=BASE+"/realms/fixture/protocol/openid-connect/registrations?"+urllib.parse.urlencode({"client_id":"fixture","redirect_uri":BASE+"/callback","response_type":"code","scope":"openid"})
    parser=Form();parser.feed(browser.open(url,timeout=15).read().decode());assert parser.action,"Missing registration page"
    fields={**parser.hidden,"username":"synthetic-"+secrets.token_hex(8),"email":email,"firstName":"Synthetic","lastName":"Fixture","password":password,"password-confirm":password}
    try: browser.open(urllib.request.Request(parser.action,data=urllib.parse.urlencode(fields).encode()),timeout=15).read()
    except urllib.error.HTTPError as e:
        if e.code not in (302,303):
            Path("/tmp/modeller-registration-response.html").write_bytes(e.read())
            raise AssertionError(f"Unexpected registration HTTP status {e.code}; synthetic response saved locally")
    users=request("/admin/realms/fixture/users?"+urllib.parse.urlencode({"email":email,"exact":"true"}),token=token)
    return users
try:
    jar=Path(__file__).parent/"target/registration-domains-1.0.0.jar"
    assert jar.is_file()
    docker("run","-d","--name",name,"--memory=1g","--cpus=2","-p","127.0.0.1::8443","-e","KC_BOOTSTRAP_ADMIN_USERNAME=fixture-admin","-e","KC_BOOTSTRAP_ADMIN_PASSWORD="+password,"-v",str(tlsdir)+":/tls:ro","-v",str(jar.resolve())+":/opt/keycloak/providers/registration-domains.jar:ro","quay.io/keycloak/keycloak:26.8.2@sha256:7e66a96e4739239070aeaf72e4c5decf0f7f682cfc725b9f7ea2b336eaba38b3","start-dev","--http-enabled=false","--https-certificate-file=/tls/cert.pem","--https-certificate-key-file=/tls/key.pem")
    BASE="https://"+docker("port",name,"8443/tcp")
    for attempt in range(120):
        try: request("/realms/master/.well-known/openid-configuration");break
        except (OSError,urllib.error.URLError): time.sleep(1)
    else: raise AssertionError("Disposable Keycloak did not become ready")
    data=urllib.parse.urlencode({"client_id":"admin-cli","username":"fixture-admin","password":password,"grant_type":"password"}).encode()
    token=json.load(trusted.open(urllib.request.Request(BASE+"/realms/master/protocol/openid-connect/token",data=data),timeout=15))["access_token"]
    def api(path,method="GET",value=None): return request("/admin/realms/fixture"+path,method,value,token)
    request("/admin/realms","POST",{"realm":"fixture","enabled":True,"registrationAllowed":True,"clients":[{"clientId":"fixture","enabled":True,"publicClient":True,"standardFlowEnabled":True,"redirectUris":[BASE+"/callback"]}]},token)
    api("/roles","POST",{"name":"platform-user"});api("/roles","POST",{"name":"platform-admin"})
    api("/groups","POST",{"name":"Users"});group=api("/groups")[0]
    api("/groups/"+group["id"]+"/role-mappings/realm","POST",[api("/roles/platform-user")])
    api("/default-groups/"+group["id"],"PUT")
    api("/authentication/flows/registration/copy","POST",{"newName":"Restricted registration"})
    flows=api("/authentication/flows");flow=next(x for x in flows if x["alias"]=="Restricted registration")
    executions=api("/authentication/flows/Restricted%20registration/executions")
    page=next(x for x in executions if x.get("authenticationFlow"))
    pageAlias=api("/authentication/flows/"+page["flowId"])["alias"]
    api("/authentication/flows/"+urllib.parse.quote(pageAlias,safe="")+"/executions/execution","POST",{"provider":"modeller-registration-domains"})
    execution=next(x for x in api("/authentication/flows/Restricted%20registration/executions") if x.get("providerId")=="modeller-registration-domains")
    api("/authentication/flows/Restricted%20registration/executions","PUT",{"id":execution["id"],"requirement":"REQUIRED"})
    api("/authentication/executions/"+execution["id"]+"/config","POST",{"alias":"Approved domains","config":{"allowed-domains":"gmail.com,ey.com,*.ey.com,hygeoniq.com,alpamax.eu"}})
    api("","PUT",{"registrationFlow":"Restricted registration"})
    for email in ["synthetic@gmail.com","synthetic@ey.com","synthetic@uk.ey.com","synthetic@hygeoniq.com","synthetic@alpamax.eu"]:
        users=register(email);assert len(users)==1,"Approved domain did not create exactly one account"
        roles=api("/users/"+users[0]["id"]+"/role-mappings/realm/composite")
        assert any(x["name"]=="platform-user" for x in roles) and all(x["name"]!="platform-admin" for x in roles),"Registration account type is not User"
    for email in ["synthetic@other.test","synthetic@ey.com.evil.test","synthetic@sub.gmail.com"]:
        assert not register(email),"Disallowed domain created an account"
    api("/users","POST",{"username":"manual-outside","email":"manual@outside.test","enabled":True})
    user=api("/users?username=manual-outside&exact=true")[0]
    api("/users/"+user["id"],"PUT",{"firstName":"Updated"})
    assert api("/users/"+user["id"])["firstName"]=="Updated","Registration restriction affected administrator provisioning"
    print("PASS: actual Keycloak registration accepts five domain cases, denies three without creating accounts, defaults to User, and preserves outside-domain admin provisioning.")
finally:
    subprocess.run(["docker","rm","-f",name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    tls.cleanup()
