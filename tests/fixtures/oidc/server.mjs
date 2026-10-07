// Isolated acceptance issuer only. Not copied into any production image.
import https from 'node:https';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const issuer = 'https://oidc-fixture:8443';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(subject, role, tenant) {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = encode({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' }) + '.' + encode({
        iss: issuer, aud: 'modelling-api-test', sub: subject, iat: now, exp: now + 1800,
        scope: 'modelling.read', roles: [role], tenant,
    });
    return unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
}
writeFileSync('/fixture-data/tokens.json', JSON.stringify({
    OIDC_SMOKE_WRITER_TOKEN: token('writer', 'modeller', 'one'),
    OIDC_SMOKE_READER_TOKEN: token('reader', 'reader', 'one'),
    OIDC_SMOKE_OTHER_TENANT_TOKEN: token('other', 'modeller', 'two'),
}), { mode: 0o600 });
https.createServer({ key: readFileSync('/fixture-data/tls.key'), cert: readFileSync('/fixture-data/tls.crt') }, (req, res) => {
    const data = req.url === '/.well-known/openid-configuration'
        ? { issuer, jwks_uri: issuer + '/keys' }
        : req.url === '/keys' ? { keys: [jwk] } : null;
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data || { error: 'not_found' }));
}).listen(8443, '0.0.0.0');
