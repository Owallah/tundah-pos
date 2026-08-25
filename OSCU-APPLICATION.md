# KRA eTIMS OSCU — application and go-live

Two halves: **getting the credentials** (weeks, mostly waiting on KRA) and
**what to do once you have them** (a day of work, then certification).

Start Part 1 now, in parallel with everything else. It is the longest pole in
the project and none of it depends on the software being finished.

---

# Part 1 — Getting OSCU credentials

## Before you start, have these ready

| | |
|---|---|
| KRA PIN | The company PIN for Tundah Taamu Delights |
| iTax login | Password for that PIN |
| Certificate of Incorporation | Or business registration certificate |
| Director's ID and KRA PIN | For the person signing |
| Tax compliance | **Must be current.** An outstanding return or debt stops the application dead — clear it first |
| Business email and phone | These become the eTIMS contact of record |
| Bank details | For the account the business trades through |

## Step 1 — Confirm VAT registration status

This decides your product tax codes and cannot be guessed.

Log into **iTax → Registration → Amend PIN details** and check whether VAT is
an active obligation.

- **VAT registered** → your smoothies and juices are tax type `B` (16%),
  unprocessed produce is `A` or `C`.
- **Not registered** → everything is tax type `D` (Non-VAT). You still need
  eTIMS; every business does.
- **Turnover approaching KES 5 million** → you will have to register. Ask your
  accountant whether to do it now rather than mid-season, because switching
  tax codes across a live catalogue is disruptive.

Record the answer. It is question **Q1** in the project docs and it gates the
catalogue seed.

## Step 2 — Register on the eTIMS taxpayer portal

1. Go to **<https://etims.kra.go.ke>**
2. **Sign Up** with the company KRA PIN
3. A verification code goes to the phone number registered against that PIN in
   iTax. If that number is stale, fix it in iTax first — this is the most
   common place the process stalls.
4. Set a password and complete the profile

## Step 3 — Choose the right eTIMS type

You will be asked to pick a solution. **Choose the system-to-system option**,
described as *eTIMS OSCU (Online Sales Control Unit)* or *Online Sales Control
Unit for system integration*.

Do **not** pick:

- **eTIMS Client / eTIMS Lite** — a standalone app a person types invoices
  into. Fine for a small office, useless for a POS, and it cannot be driven
  by software.
- **VSCU (Virtual Sales Control Unit)** — designed for taxpayers running their
  own server. You are cloud-only, so this is the wrong shape and would force
  infrastructure you deliberately avoided.

If the portal wording is ambiguous, say this to the officer: *"We have a
cloud-based point-of-sale system and need OSCU credentials for direct API
integration."*

## Step 4 — Submit the service request

Complete the eTIMS commitment form / service request. It asks for:

- Business details and branch information (you will get a **branch ID**,
  usually `00` for head office)
- The type of system being integrated (a cloud POS)
- Estimated invoice volume
- Technical contact — **put your own email here**, not the accountant's. KRA
  sends the sandbox credentials and the specification pack to this address.

## Step 5 — Email the integration team directly

The portal alone often stalls. In parallel, email:

**timsupport@kra.go.ke**

Copy your KRA relationship officer if you have one. Suggested text:

> Subject: OSCU sandbox credentials request — [KRA PIN]
>
> We are a VAT-registered retailer operating a cloud-based point-of-sale
> system and require OSCU (Online Sales Control Unit) credentials for
> system-to-system eTIMS integration.
>
> KRA PIN: [PIN]
> Business name: Tundah Taamu Delights
> Branch: Head office
> Integration type: Cloud POS, direct REST API (non-Java)
>
> Please provide:
> 1. Sandbox credentials and the assigned device serial number
> 2. The current OSCU technical specification and Postman collection
> 3. The certification test cases and process
> 4. Confirmation of the production onboarding steps
>
> Technical contact: [your name, email, phone]

**Ask explicitly for the Postman collection.** It is the single most useful
artefact and is not always sent unprompted.

## Step 6 — Verification

KRA may require:

- A **verification call or visit** to confirm the business exists and trades
  as described
- **KYC documents** re-submitted
- A short **technical discussion** about your integration

Have the architecture summary to hand: cloud-hosted POS, three tills, direct
REST integration, one OSCU device serving all three.

## Step 7 — Receive sandbox credentials

You should receive:

| Item | Looks like | Notes |
|---|---|---|
| `tin` | `P051234567M` | Your KRA PIN |
| `bhfId` | `00` | Branch ID |
| `dvcSrlNo` | KRA-assigned | **Never invent this.** It must be the value KRA issued |
| Sandbox base URL | `https://etims-api-sbx.kra.go.ke/etims-api` | |
| Specification | PDF | Check the version — ours was built against v2.0 |

The **`cmcKey` is not issued by email.** You obtain it yourself by calling
`/selectInitOsdcInfo` once with the three values above. It comes back in the
response and must then be stored server-side and never exposed.

## Realistic timeline

| Stage | Typical |
|---|---|
| Portal registration | Same day |
| Service request acknowledged | 3–10 working days |
| Sandbox credentials issued | 1–3 weeks |
| Certification testing | 1–2 weeks of your effort |
| Production credentials | 1–2 weeks after passing |

**Six to eight weeks end to end is normal.** Plan around it rather than
against it.

---

# Part 2 — Once you have the credentials

## Step 1 — Store them, correctly

```bash
supabase secrets set \
  ETIMS_PROVIDER=oscu \
  ETIMS_ENVIRONMENT=SANDBOX \
  ETIMS_TIN=P051234567M \
  ETIMS_BHF_ID=00 \
  ETIMS_DVC_SRL_NO=<exactly what KRA issued> \
  ETIMS_OPERATOR_ID=POS \
  ETIMS_OPERATOR_NAME="Tundah Taamu Delights POS"
```

Nothing eTIMS-related goes in `.env.local` with a `NEXT_PUBLIC_` prefix.
`npm run check:secrets` fails the build if it does.

## Step 2 — Initialise the device, once

```ts
const provider = createEtimsProvider();   // ETIMS_PROVIDER=oscu
const init = await provider.initialiseDevice();
```

Store the returned `cmcKey` in `etims_device_state`, which has RLS enabled
with no policy precisely so a client can never read it:

```sql
insert into etims_device_state (
  business_id, dvc_srl_no, dvc_id, sdc_id, mrc_no,
  cmc_key_encrypted, initialised_at, environment)
values ('<business_id>', '<serial>', '<dvcId>', '<sdcId>', '<mrcNo>',
        '<cmcKey>', now(), 'SANDBOX');
```

**Run this once.** Calling `/selectInitOsdcInfo` again on an initialised
device returns error `902 Device already installed`.

## Step 3 — Sync KRA's reference data

```ts
await provider.syncCodeList(new Date('2020-01-01'));
await provider.syncItemClassifications(new Date('2020-01-01'));
```

Write the results into `etims_code_list` and `etims_item_classifications`.

**This is where your VAT rates come from.** `tax_rate_bp()` reads them from
that table and only falls back to hardcoded values when it is empty. After
this sync the rates are KRA's, not ours — which is the point.

## Step 4 — Resolve the open questions

These have been carried in the code as `K1`–`K9` since the architecture phase.
Certification is when they get answered. `grep -rn "K3\|K4\|K5" src/` finds
every place that matters.

| id | Question | Why it bites |
|---|---|---|
| **K3** | Is `taxblAmt` VAT-inclusive or exclusive? | **The expensive one.** KRA's own v2.0 samples contradict each other: the sales sample extracts VAT from gross, the purchase sample adds it to net. Getting it wrong means either every invoice rejected, or systematic misdeclaration. `ETIMS_TAXABLE_CONVENTION=gross\|net` |
| **K5** | Are `tin`/`bhfId`/`cmcKey` sent in the body or as HTTP headers? | v2.0 documents the body; current SDKs use headers. `ETIMS_AUTH_TRANSPORT=body\|header\|both` |
| **K4** | Which `pmtTyCd` for split tender (cash + M-Pesa)? | eTIMS has one payment code per invoice. `07 OTHER` is the likely answer |
| **K1** | Is queued fiscalisation acceptable during an eTIMS outage? | Get this **in writing**. It underpins the whole two-stage receipt design |
| **K2** | May one OSCU device serve three tills? | We register one device for the cloud backend. If KRA requires one per till, `invcNo` must be sequenced per device — a schema change |
| **K6** | Exact QR payload / verification URL format | Not documented in v2.0. `qrPayload` is deliberately left `undefined` rather than guessed |
| **K7** | Must `saveStockMaster` fire after every sale, or periodically? | Changes queue volume by an order of magnitude |
| **K8** | Is there a spec newer than v2.0 (April 2023)? | Ask when they send the pack |

## Step 5 — Register your products

Every product must reach KRA before it can appear on an invoice.

1. Set each product's `etims_item_cls_cd` from the synced UNSPSC list
   (`/admin/products`)
2. Run `provider.registerItem()` for each
3. Confirm `etims_registered_at` is set

`complete_sale()` already refuses any product without a tax type, so an
unclassified item cannot reach an invoice — but registration is a separate
step and is easy to forget.

## Step 6 — Certification

Work KRA's test cases in sandbox. Cover at minimum:

- [ ] Standard-rated sale (a smoothie, tax type B)
- [ ] Zero-rated or exempt sale (whole fruit)
- [ ] **Mixed-band sale** — a smoothie and a mango on one receipt. This is
      your normal basket and the one most likely to expose a K3 error
- [ ] Split tender (cash + M-Pesa) — resolves K4
- [ ] Credit note against a prior invoice
- [ ] Stock in/out following a sale, in KRA's mandatory order
- [ ] A deliberate duplicate submission — must return `994` and be treated as
      success, not retried

Then confirm against `report_vat` that what you declared matches what you
submitted. If those two disagree, stop and find out why before going live.

## Step 7 — Production

1. Request production credentials from KRA once certification passes
2. Re-run `initialiseDevice()` against the production URL — **a new `cmcKey`**
3. `ETIMS_ENVIRONMENT=PRODUCTION`
4. **Keep `ETIMS_PROVIDER=mock` for one more day** and watch the queue drain
   cleanly end to end
5. Switch to `oscu` and take **one real sale**. Verify:
   - `invoices` has a row with a real `rcptSign`
   - The receipt shows TAX INVOICE, not PROVISIONAL
   - `/r/{token}` renders the fiscal block
   - `report_etims_status()` shows nothing stuck

## Step 8 — Watch the queue for the first week

`/admin/reports` → eTIMS status. Two numbers matter:

- **`awaiting_fiscalisation`** creeping up means the worker is not draining.
- **`halted: true`** means an ordering violation (`921`/`922`). The queue stops
  deliberately. Do not restart it blindly — a broken submission sequence has
  to be reconciled with KRA by hand, and pushing more requests makes that
  worse.

---

## Things that will go wrong, and what they mean

| Symptom | Cause |
|---|---|
| `901 Invalid device` | `dvcSrlNo` does not match what KRA issued, or the wrong environment |
| `902 Device already installed` | `initialiseDevice()` called twice. Use the stored `cmcKey` |
| `921` / `922` | Ordering violation. Sale must precede stock IO, which must precede stock master |
| `994 Duplicate data` | Already submitted. Treat as success — the worker already does |
| `894 Communication error` | KRA is down. The queue backs off up to 6 hours. Sales continue |
| Every call fails auth | K5 — try `ETIMS_AUTH_TRANSPORT=header` |
| Invoices rejected on amounts | K3 — try the other `ETIMS_TAXABLE_CONVENTION` |

## Compliance note

eTIMS is mandatory and penalties under the Finance Act are significant —
**KES 100,000 for companies** per offence at the time of writing. eTIMS itself
also suffers outages; there was a multi-day one in July 2026.

That is exactly why sales never block on eTIMS in this design. Trading
continues, invoices queue, and they submit when KRA returns. Confirm with KRA
in writing that this is acceptable (**K1**) and keep the reply.
