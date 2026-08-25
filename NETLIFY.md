# Deploying to Netlify

## The error you hit

```
An error occurred in the Server Components render.
digest: 2178287683
```

Next.js hides the real message in production builds. In practice this is
almost always **a missing environment variable**: `serverClient()` throws when
`NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` is absent, and
the root page calls it on the first request.

**Go to `/setup` on your deployed site.** It names exactly which variables are
missing, and it never renders a secret value — only whether one is present and
whether it has the right shape.

---

## 1 · Environment variables

**Site configuration → Environment variables.** Set the scope to **All deploy
contexts** unless you have a reason not to.

| Variable | Where it comes from |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page → `anon` (or `publishable`) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → `service_role` (or `secret`) key |
| `BUSINESS_ID` | `select business_id from businesses;` |
| `ETIMS_PROVIDER` | `null` until KRA certification |
| `MPESA_PROVIDER` | `ncba-paybill` |

⚠️ `SUPABASE_SERVICE_ROLE_KEY` bypasses every RLS policy. It must **never**
carry a `NEXT_PUBLIC_` prefix.

## 2 · The step people miss

**`NEXT_PUBLIC_*` values are baked into the JavaScript bundle at BUILD time.**

Adding them and waiting changes nothing — the already-built bundle still has
`undefined` compiled in. After adding or editing any variable:

**Deploys → Trigger deploy → Clear cache and deploy site**

"Clear cache" matters. A plain redeploy can reuse the cached build output and
you will see no change, which is a very confusing ten minutes.

## 3 · The Next.js plugin

`netlify.toml` is now in the repo and declares `@netlify/plugin-nextjs`. That
plugin is what makes App Router server components, route handlers and
middleware work. Without it Netlify publishes static output and every dynamic
page fails at request time.

Confirm in **Site configuration → Build & deploy → Build plugins** that
*Next.js Runtime* is listed after your next deploy.

## 4 · Supabase must allow your Netlify URL

**Supabase → Authentication → URL Configuration:**

- **Site URL:** `https://your-site.netlify.app`
- **Redirect URLs:** add `https://your-site.netlify.app/**`

Miss this and sign-in appears to work but the session never sticks — you land
back on `/login` in a loop.

## 5 · Deploy order

```
1. supabase db push                    # 0001–0018
2. run supabase/seed/demo.sql
3. create the auth users + link_till / link_staff
4. enable the JWT hook
5. set Netlify env vars
6. clear cache and deploy
7. open /setup  → everything green
8. open /login
```

---

## Reading the real error

If `/setup` is green and you still get a digest, the message is in Netlify's
logs — the digest is just a pointer.

**Logs → Functions →** find the invocation and search for the digest number.
The full stack trace is there.

For a faster loop locally:

```bash
npm run build && npm start
```

A production build run locally prints the real error instead of hiding it.

## Other things that produce a digest error

| Cause | Tell |
|---|---|
| Missing env var | `/setup` shows it |
| Auth URLs not configured | Login loops back to `/login` |
| JWT hook not enabled | Signs in, then "Setup incomplete" |
| Migrations not pushed | `relation "businesses" does not exist` in function logs |
| `@netlify/plugin-nextjs` absent | Every dynamic route fails, static ones work |

## A note on Netlify for the tills

Netlify is fine for the demo. Before a real event, check two things:

1. **Cold starts.** Netlify Functions can idle out. First request of the
   morning may take a few seconds — worth knowing before a queue forms.
2. **Region.** Netlify's default is US-centric. With Supabase in Frankfurt or
   Mumbai, every server render crosses the Atlantic twice. The till talks to
   Supabase *directly* for sales so this does not affect selling speed, but it
   does affect admin page loads.

Neither is a reason to move for the demo. Both are worth measuring before you
commit to it for trading.
