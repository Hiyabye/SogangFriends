# University certificate-chain completion

`sogang-ov-r36.pem` is a **public intermediate CA certificate**, not a private key or secret. It completes the certificate chain currently omitted by `www.sogang.ac.kr` for the standalone Node notice collector. Normal TLS certificate and hostname verification remain enabled.

- Subject: `Sectigo Public Server Authentication CA OV R36`
- Issuer: `Sectigo Public Server Authentication Root R46`
- SHA-256 fingerprint: `65:42:D1:76:BE:D5:0F:19:3C:0C:E2:97:AE:44:EC:D8:A0:A8:6B:EC:2E:DE:68:27:69:34:40:59:B4:E7:85:30`
- Validity: 2021-03-22 through 2036-03-21 23:59:59 GMT
- Official issuer artifact: <http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt>

The certificate was obtained from this issuer URL, decoded with Node `X509Certificate`, and independently verified to have the expected fingerprint, CA constraint, and a valid issuer/signature against Node's trusted R46 root **before saving the PEM**. Although the issuer distributes the public certificate over HTTP, authenticity is established cryptographically; university requests themselves use HTTPS only. The reference repository's code and certificate bundle were not copied. Its unrelated GoGetSSL intermediate was not included.

Before every collector run, `scripts/notice-collector.mjs::verifyCertificate` requires exactly one PEM certificate with no additional trust/private-key blocks, then repeats fingerprint, CA status, validity and trusted-root signature checks. A changed, expired or untrusted certificate fails closed. The CLI also refuses `NODE_TLS_REJECT_UNAUTHORIZED=0` and requires the expected `NODE_EXTRA_CA_CERTS` file.

Launch only this process with additional CA material:

```sh
NODE_EXTRA_CA_CERTS=certificates/sogang-ov-r36.pem node scripts/notice-collector.mjs --dry-run
```

`NODE_EXTRA_CA_CERTS` is read by Node at process startup; setting it inside an already-running program does not alter that process's trust. This is not a system-wide trust-store modification. The extra intermediate applies to the scoped Node process, including its HTTPS ingestion request; existing Node trusted roots remain available.

Workers `fetch` cannot consume this file. Workers' `node:https` is a `fetch` wrapper and does not support `ca`: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/https/>. Do not deploy this PEM as a supposed Worker TLS fix or disable verification to work around the origin problem.

If the university changes its issuer or this certificate approaches expiry, investigate the new chain and verify issuer provenance, fingerprint and signature before intentionally updating this file and its pinned fingerprint/tests. Do not auto-download new trust material during collection.
