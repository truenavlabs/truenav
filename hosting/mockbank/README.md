# Mock bank host (H1)

A Vercel project whose root is this folder. It serves the mock bank-data API (`cashflow/mockbank/server.mjs`) with
synthetic data only: the three documents the TrueNav TEE module fetches for each of the 4 synthetic funds
(DEMO-CREDIT, DEMO-RENTAL, HONEST-CREDIT, HONEST-RENTAL). Every response carries `X-Synthetic-Data: true`. It is
read only and holds no real data.

| Route | Auth | Answer |
| --- | --- | --- |
| `GET /health` | none | `{ ok, synthetic }` |
| `GET /v1/tokens/<fund>/bank-feed`, `/manager-export`, `/issuer-claims` | `Authorization: Bearer <TRUENAV_DATA_TOKEN>` | the frozen document bytes, `X-Snapshot-Sha256` |

No or a wrong token is 401, an unknown fund or route is 404, any method other than GET is 405. Every response
carries `X-Content-Type-Options: nosniff`; a rewritten path that is not a plain local path (a second leading slash,
a scheme, `%00` or another control character, `.` or `..` segments) is 404. The token is compared
in constant time and is never logged. If `TRUENAV_DATA_TOKEN` is unset or shorter than 32 characters, every data
route answers 503 and serves nothing (fail closed); `/health` stays up and says `configured: false`.

## Deploy (each step needs the owner's yes)

1. Create one Vercel project from this repository with **Root Directory** `hosting/mockbank` (not the repository
   root, which has its own `api/`). Framework preset: Other. No build command, no output directory.
2. Keep "Include source files outside of the Root Directory" enabled: the function imports
   `../../../cashflow/mockbank/` and `../../../cashflow/demo/data.mjs`.
3. Generate the token locally (at least 32 characters, for example `openssl rand -hex 32 > token.txt`) and add it as
   the environment variable `TRUENAV_DATA_TOKEN` for Production from that file (the dashboard, or
   `vercel env add TRUENAV_DATA_TOKEN production < token.txt`). Never put it in git, chat, logs or a URL.
4. Deployment protection must let the TEE reach the production URL without a Vercel login (production only; leave
   previews protected).
5. Check: `curl -s <url>/health` gives `{"ok":true,"synthetic":true}`; a data route without the token gives 401.
6. O3 seals `TRUENAV_DATA_URL=<url>` and `TRUENAV_DATA_TOKEN` (from the same file) for the engine
   (`receipts/README.md`). Then delete `token.txt`.

## Tests

```bash
node --test hosting/mockbank/test/adapter.test.mjs   # all-funds token, 401s, fail closed without the env, /health, rewrite
```
