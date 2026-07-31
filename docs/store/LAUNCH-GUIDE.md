# Launch Guide — putting this app in the App Store and Google Play

**Written for a first-timer.** No prior app-store experience assumed. Every
step says what to click, what it costs, and how long the wait is. Technical
work is already done — the app builds, is signed by robots once you paste in
keys, and all the text you'll be asked for is pre-written in
[`README.md`](README.md) so you can copy-paste.

**Costs:** Apple $99/year · Google $25 once.
**Realistic timeline:** Apple ~1–2 weeks · Google ~3 weeks (their testing rule
adds 14 days, explained below).

---

## Step 0 — One decision before spending money

The app currently uses the name and colors of **Stream Data Centers**. App
stores check that you have the right to a brand. Pick one:

- **A. The company publishes it.** They create the accounts (or add the app to
  accounts they have). Cleanest if this is for/with them.
- **B. You get written permission** to publish it under your own account.
- **C. Rebrand.** Say the word and the name/colors/bundle-id get changed to
  something that's yours; everything else stays identical.

Don't skip this — "app impersonates a business" is a standard rejection on
both stores, and the fix after the fact means re-doing the listing.

---

## Apple (iPhone / iPad)

### 1. Create the developer account — you, ~30 min + a wait

1. Go to <https://developer.apple.com/programs/enroll/>
2. Sign in with (or create) an Apple ID. Turn on two-factor if asked.
3. Choose **Individual** (or **Organization** if the company publishes —
   that path asks for a D-U-N-S number; their support helps find it).
4. Pay the **$99/year**. Apple verifies identity — usually **1–3 days**.
   You'll get an email when you're in.

### 2. Create the app record — you, ~10 min

1. Go to <https://appstoreconnect.apple.com> → **My Apps** → **+** → **New App**.
2. Platform: iOS. Name: `Hall Environment Planner`. Language: English.
3. Bundle ID: register `com.streamdatacenters.psychro` when prompted
   (Certificates page → Identifiers → **+** → App IDs).
4. SKU: anything, e.g. `psychro-001`.

### 3. Make the three keys the robot needs — you, ~20 min, one time

The build robot signs and uploads the app for you — **you never need a Mac**.
It needs three things, pasted into GitHub as "secrets" (a secret is just a
password box only the robot can read):

1. **API key:** App Store Connect → **Users and Access** → **Integrations** →
   **App Store Connect API** → **+**. Role: **App Manager**. Download the
   `.p8` file (you can only download it once — keep it safe).
   Note the **Key ID** and **Issuer ID** shown on that page.
2. **Distribution certificate + profile:** follow
   [`signing.md`](signing.md) §iOS — it's click-by-click on the same website.
3. **Paste into GitHub:** your repo → **Settings** → **Secrets and variables**
   → **Actions** → **New repository secret**, once per row in `signing.md`'s
   iOS table (7 secrets total). Copy names EXACTLY.

### 4. Push the button — you, 1 click

GitHub repo → **Actions** tab → **Release builds (store upload)** → **Run
workflow** → platform `ios` → green **Run workflow** button.

~15 minutes later your app appears in **TestFlight** (App Store Connect →
your app → TestFlight tab). Install the TestFlight app on your iPhone, add
yourself as a tester, and try your own app. This step is worth a day of
playing with it.

> If the workflow stops with a note saying secrets aren't set up, that's the
> friendly guard — nothing broke; finish step 3 and run it again.

### 5. Fill in the listing — you, ~30 min of copy-paste

In App Store Connect → your app → the version page. Everything is pre-written
in [`README.md`](README.md):

| Field | Where to get it |
|---|---|
| Description, subtitle, keywords | README.md "Listing copy" |
| Screenshots (iPhone 6.9" + iPad 13") | `docs/store/screenshots/` — already the exact sizes |
| Privacy policy URL | `https://thorhale.github.io/Psychro/privacy.html` |
| Privacy questions ("App Privacy") | README.md Apple table — everything is "No data collected" |
| Age rating questionnaire | Answer everything "No" → 4+ |
| Support URL | `https://github.com/thorhale/Psychro` |
| Review notes | README.md "Review notes" block |

Price: Free. Category: **Utilities** (secondary: Productivity).

### 6. Submit and survive review — mostly waiting

Click **Add for Review** → **Submit**. Review usually takes **1–3 days**.

**If it's rejected**, don't panic — first submissions of web-technology apps
often get one rejection citing "Guideline 4.2 – Minimum Functionality." Reply
in the Resolution Center with this (already true, just say it):

> This is a professional engineering calculator, not a repackaged website. It
> works fully offline, stores all data on-device, uses native share/storage
> integration, and performs ASHRAE psychrometric computation validated against
> the CoolProp reference library (accuracy documentation included in-app).
> There is no equivalent functionality on our website beyond the app itself.

Then it typically passes on the next look.

---

## Google (Android)

### 1. Create the Play Console account — you, ~30 min + a wait

1. Go to <https://play.google.com/console/signup>
2. Pay the **$25 one-time** fee. Google verifies identity (photo ID) —
   usually **1–2 days**.

### 2. Create the app — you, ~10 min

**Create app** → name `Hall Environment Planner`, App (not game), Free.
Accept **Play App Signing** when offered (default — Google guards the final
key so you can't lose it).

### 3. Make the signing key — you, ~15 min, one time

Follow [`signing.md`](signing.md) §Android: one copy-paste terminal command
creates `upload-keystore.jks`, then paste the four secrets into GitHub
(Settings → Secrets → Actions), same as the Apple ones.

> ⚠️ **Back up `upload-keystore.jks` and its passwords somewhere safe (a
> password manager).** With Play App Signing, Google can rescue you if it's
> lost, but the reset process takes days. Treat it like a house key.

### 4. Push the button, then drag one file — you, ~10 min

1. GitHub → **Actions** → **Release builds (store upload)** → platform
   `android` → **Run workflow**.
2. When it finishes, open the run and download **psychro-release-aab** (a
   `.zip` containing a `.aab` file — that's the app, signed).
3. Play Console → your app → **Testing → Internal testing** → **Create
   release** → drag the `.aab` in → **Save** → **Review release** → roll out.

### 5. The 12-testers rule — the honest bottleneck

New personal accounts must run a **closed test with at least 12 testers for
14 consecutive days** before Google unlocks public publishing. It's a
spam-prevention rule; there is no way around it, only through it:

1. **Testing → Closed testing** → create a track, upload the same `.aab`.
2. Add 12+ tester email addresses (family, coworkers, a homebrew club — the
   testers just need Google accounts).
3. Send them the opt-in link the console shows. **All they do is tap the
   link, install the app, and keep it installed 14 days.** Opening it now and
   then helps.
4. After 14 days, the console shows an **Apply for production** button.

### 6. Fill in the listing — you, ~30 min of copy-paste

**Grow → Store presence → Main store listing**, plus the **App content**
questionnaire section. All answers pre-written in [`README.md`](README.md):

| Field | Where to get it |
|---|---|
| Short + full description | README.md "Listing copy" |
| Screenshots (phone + tablet) | `docs/store/screenshots/` |
| Feature graphic (the banner) | `docs/store/screenshots/feature-graphic.png` |
| App icon 512×512 | `icon-512.png` at the repo root |
| Privacy policy URL | `https://thorhale.github.io/Psychro/privacy.html` |
| Data safety form | README.md Play table — "No data collected / shared" |
| Content rating (IARC questionnaire) | Everything "No" |
| Ads / target audience | No ads · 18+ |

### 7. Go live

After the 14-day test: **Production → Create release** → same `.aab` →
roll out. First production review can take up to a week; updates after that
are usually hours.

---

## The complete pre-flight checklist

Everything either store will ask for, and where it stands:

| Requirement | Status |
|---|---|
| App builds and passes review-quality checks | ✅ automated (200+ checks in CI) |
| Signing set up | 🤖 robot-ready — needs your secrets (Apple §3, Google §3) |
| Privacy policy URL, live | ✅ `https://thorhale.github.io/Psychro/privacy.html` |
| Privacy policy inside the app | ✅ footer → Privacy |
| Apple privacy "nutrition label" answers | ✅ pre-written (README.md) |
| Play Data safety answers | ✅ pre-written (README.md) |
| Encryption/export declaration | ✅ declared in the app (`false`) |
| App icons (1024 Apple / 512 + launcher set Google) | ✅ in the repo |
| Screenshots, every required size | ✅ `docs/store/screenshots/` |
| Play feature graphic 1024×500 | ✅ `docs/store/screenshots/feature-graphic.png` |
| Listing text, keywords, review notes | ✅ pre-written (README.md) |
| Age/content rating answers | ✅ pre-written (all "No") |
| Support URL | ✅ the GitHub repo |
| Version numbers synced and Play-compliant | ✅ automated check |
| Developer accounts | ❌ you (Apple §1, Google §1) |
| Branding decision | ❌ you (Step 0) |
| 12 testers × 14 days (Play) | ❌ you (Google §5) |
| Tap "Submit" | ❌ you |

## After launch — how updates work

1. Changes get merged as usual (tests gate everything).
2. Bump the version, run the **Release builds** workflow again.
3. Apple: the new build appears in TestFlight → submit it. Google: upload the
   new `.aab` to Production.
4. The **website updates itself** on every merge regardless — store releases
   are only for the installed native apps.

**Never lose:** the Android keystore + passwords, and the Apple `.p8` API key
file. Both are one-time downloads. Password manager.
