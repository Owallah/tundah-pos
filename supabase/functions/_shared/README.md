# Shared function code

`daraja.ts` is **generated**. The canonical copy is `src/lib/mpesa/daraja.ts`.

Edge Functions run on Deno and cannot import from `src/`, so the file is
mirrored here by `npm run sync:shared`. `npm run check:shared` fails if the
two diverge, which is wired into `npm run verify` — drift becomes a red build
rather than a subtle production difference between the app and the webhooks.

After editing `src/lib/mpesa/daraja.ts`:

```bash
npm run sync:shared
```
