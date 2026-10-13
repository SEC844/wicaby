# TEST ONLY

`key1.pem`/`cert1.pem` and `key2.pem`/`cert2.pem` are two self-signed pairs (CN "dav.example", SAN
`dav.example` and `127.0.0.1`, valid 10 years) for `tools/mock-server/mock-webdav.mjs` with `MOCK_DAV_TLS=1`.
`POST /Mock/RotateCert` switches the listener to the second pair, so the per-source certificate pin
(file-sources-spec §7.3) can be seen to fail. They are public on purpose and protect nothing. Never reuse them.

Generated once with:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout key1.pem -out cert1.pem -days 3650 \
  -subj "/CN=dav.example/O=Wicaby TEST ONLY 1" -addext "subjectAltName=DNS:dav.example,IP:127.0.0.1"
```

(and the same with `2`).
