# TEST ONLY

`key.pem` and `cert.pem` are a self-signed pair (CN "mock-cast TEST ONLY", valid 100 years) for
`tools/mock-server/mock-cast.mjs`, the mock Chromecast of the cast spec (CA-06). They are public on purpose:
the CASTV2 sender skips certificate checks (`rejectUnauthorized: false`, cast spec CA-09 and §6), so this pair
protects nothing. Never reuse it for anything else.

Generated once with:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 36500 -subj "/CN=mock-cast TEST ONLY"
```
