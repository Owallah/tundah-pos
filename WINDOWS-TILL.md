# Setting up a Windows 11 till

Nothing architectural changes — the till is a browser client, so the OS is
just a host. But **four Windows defaults will break a till mid-event**, and
they are the whole reason this document exists.

Do these on every machine, not just the first.

---

## The four that matter

### 1. Wi-Fi adapter power saving — highest risk

Windows powers down the wireless adapter to save battery. On a laptop
tethered to a phone hotspot, this drops the connection silently, and the till
stops selling until someone notices.

**Device Manager → Network adapters → [your Wi-Fi adapter] → Properties →
Power Management → untick "Allow the computer to turn off this device to save
power".**

Also, on the same dialog's **Advanced** tab, set any *Power Saving Mode* or
*Roaming Aggressiveness* setting to maximum performance / lowest.

### 2. Sleep, hibernate and lid close

A till that sleeps loses its Realtime connection and its session. Worse, a
cashier closing the lid to move the stall will do it mid-shift.

**Settings → System → Power & battery → Screen and sleep:**

| Setting | Value |
|---|---|
| Screen off, on battery | 30 minutes |
| Screen off, plugged in | Never |
| Sleep, on battery | **Never** |
| Sleep, plugged in | **Never** |

Then, lid behaviour — this one is buried:

**Control Panel → Hardware and Sound → Power Options → Choose what closing
the lid does → set both to "Do nothing".**

Set the power mode to **Best performance** while on AC.

### 3. Windows Update

An automatic restart during trading is a real and recurring risk.

- **Settings → Windows Update → Advanced options → Active hours:** set
  manually to cover your whole trading day, e.g. 06:00–23:00.
- Turn **off** "Get me up to date" and "Restart this device as soon as
  possible".
- **Pause updates for the week of an event.** Do the updates deliberately,
  the day before, not on the morning of.

### 4. Mark the hotspot as a metered connection

This one saves money as well as trading time. Windows will happily pull a
multi-gigabyte update over your phone's data bundle in the middle of an
event.

**Settings → Network & internet → Wi-Fi → [hotspot network] → turn on
"Metered connection".**

Windows then defers large downloads, and the POS itself uses almost nothing —
a sale is a few kilobytes.

Do this on all three tills, for both hotspot phones.

---

## Browser

**Use Microsoft Edge.** It is pre-installed, Chromium-based, and its PWA
install is slightly better integrated on Windows 11 than Chrome's. Chrome
works identically if you prefer it.

### Install the till as an app

Open `https://your-domain/till`, then **⋯ → Apps → Install this site as an
app**. Name it "Nyota Till".

This gives a standalone window with no address bar, so a cashier cannot
navigate away by accident or open a second tab. Pin it to the taskbar and set
it to open on sign-in (**Edge → Settings → Apps** or drop a shortcut into
`shell:startup`).

### Do not clear browsing data on exit

**Edge → Settings → Privacy, search, and services → Clear browsing data for
this site every time you close the browser → leave OFF.**

The till stores unresolved-sale recovery records in `localStorage`. Clearing
site data on close would delete them, which is precisely the cash-with-no-
record failure the mechanism exists to prevent.

### Zoom

Set page zoom so the touch tiles are comfortable. On a 1366×768 laptop, 90%
usually fits more products without shrinking tap targets too far. `Ctrl+0`
resets if a cashier fat-fingers it.

---

## Windows accounts

- One local account per machine, **auto sign-in enabled**, no password prompt
  on wake. A locked till in the middle of a queue is a queue.
- **Settings → Accounts → Sign-in options → turn off "If you've been away,
  when should Windows require you to sign in again"** → Never.
- No OneDrive sign-in, no personal Microsoft account. Nothing on the till
  needs syncing.

## Clock

`occurred_at` is stamped by the till's clock. Windows time drift is usually
small, but confirm:

**Settings → Time & language → Date & time → Sync now**, and leave "Set time
automatically" on.

Server time remains authoritative for ordering (`created_at_server`), so
drift degrades reporting rather than correctness — but a till an hour out
makes the sales-by-hour report useless.

## Screen

Outdoor stall, so brightness to maximum while on AC. If the venue is bright
enough that the screen is hard to read, that is a real operational problem —
check it at the venue during setup, not on the morning of trading.

---

## Optional: kiosk mode

If cashiers keep wandering out of the app, Windows 11 has **Assigned Access**
(Settings → Accounts → Other users → Set up a kiosk) which locks a local
account to Edge in kiosk mode on a single URL.

I would not start here. It makes troubleshooting harder — no taskbar, no easy
way to check Wi-Fi — and the PWA window plus a briefed cashier is usually
enough. Reach for it only if the problem actually occurs.

---

## What this machine does NOT need

The till is a browser and nothing else:

- ❌ Node.js, npm, WSL
- ❌ The repository
- ❌ Supabase CLI
- ❌ Docker

Those live on your development machine. Deployment is Vercel; the till just
opens a URL. That is the point of the cloud-only architecture — a till is
replaceable in ten minutes with any laptop that has a browser.

---

## Accept-test the machine

Before it goes to an event:

- [ ] Open the PWA. Sign in as a till, open a shift, sell something, download
      the PDF receipt.
- [ ] Close the lid for 30 seconds, reopen. **The till should still be
      connected** and the status chip green. If it went red or reloaded, power
      settings are wrong.
- [ ] Unplug the charger and leave it 15 minutes idle. Still connected.
- [ ] Tether to the phone hotspot, then walk 20 metres away and back.
      Reconnection should be automatic and the chip should recover.
- [ ] **Add items, tap Take payment, turn off Wi-Fi, tap Complete.** Expect
      the blocking "Sale status unknown". Now **restart Windows entirely.**
      Reopen the till: the unresolved sale must still be there. If it is not,
      site data is being cleared on close.
- [ ] Check battery life under real use. If the laptop cannot hold a full
      trading day, budget for a power bank or mains at the stall.

That fifth item is the one worth doing carefully. It is the test that
distinguishes a till that loses money from one that does not.

---

## If you buy more machines

Any Windows, macOS or Linux laptop with a current Chromium browser works, and
so does an iPad or Android tablet — the touch grid was designed for touch
first. There is nothing Windows-specific in the application. This document is
entirely about Windows *defaults*, not Windows *capability*.
