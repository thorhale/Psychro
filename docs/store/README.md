# Store submission collateral

Everything needed to put this app in the App Store and Play Store, except the
credentials. The projects in `android/` and `ios/` are committed and build; see
[`signing.md`](signing.md) for the steps once you have developer accounts.

## The privacy answer, which is unusually simple

This app **collects nothing and transmits nothing**. It makes zero network calls
after install. All data — halls, SLAs, scenarios, custom sites — lives in device
storage and only leaves the device if the operator explicitly exports or shares a
save file. There is no analytics SDK, no crash reporter, no ads, no accounts.

That makes both stores' privacy questionnaires short, and it is worth not
breaking: adding any telemetry would change every answer below and require a
privacy-policy URL the app currently doesn't need.

## Listing copy

**App name:** Hall Environment Planner
**Subtitle / short description (Play, 80 chars max):**
> ASHRAE TC 9.9 psychrometrics for data center temperature and humidity moves

**Full description:**

> Plan temperature and humidity changes in data center halls without leaving the
> SLA envelope.
>
> Set your current conditions and your target, and the app shows the move on a
> live psychrometric chart against ASHRAE TC 9.9 thermal guidelines (Recommended
> and allowable classes A1–A4) and your customer's contractual envelope. It tells
> you whether the target is compliant, which bound it breaks if not, and how long
> the move will realistically take given your plant's cooling, warming,
> dehumidification and humidification capacity.
>
> Built for critical facilities:
>
> • Barometric pressure corrected for site elevation — a 45 % RH reading means
>   different absolute moisture in Denver than in Houston, and the envelopes are
>   redrawn accordingly
> • Transition timing from a first-principles moisture mass balance, not a rule of
>   thumb, with an efficiency factor you calibrate from logged runs
> • Sensor validation: enter dry-bulb and wet-bulb readings from a sling
>   psychrometer and grade an installed RH sensor against the true value
> • Per-hall equipment profiles with capacity derates for degraded plant
> • Saved scenarios and shareable workspace files
> • Works fully offline. No account, no network, no data collection.
>
> The psychrometric core implements ASHRAE Handbook of Fundamentals Chapter 1 and
> is validated point-by-point against CoolProp's real-gas humid-air model
> (ASHRAE RP-1485) across the whole operating range — worst-case humidity-ratio
> deviation 0.0013 %. The app runs a live self-test on every launch and shows the
> result; tap it to see every checked value.
>
> This is a planning aid, not a control system. Verify moves against site
> instrumentation before acting.

**Category:** Business (primary) / Utilities (secondary)
**Content rating:** Everyone / 4+
**Keywords:** psychrometric, ASHRAE, data center, HVAC, dew point, humidity,
wet bulb, TC 9.9, SLA, critical facilities

## Apple App Store

| Item | Answer |
|---|---|
| Bundle ID | `com.streamdatacenters.psychro` |
| Data collection | None — see `ios/App/App/PrivacyInfo.xcprivacy` |
| Tracking | No |
| Privacy policy URL | Not required (nothing collected); supply one if the org mandates it |
| Encryption (ITSAppUsesNonExemptEncryption) | `false` — no encryption beyond OS-provided HTTPS, which the app doesn't even use |
| Age rating | 4+ |
| Sign in required | No |
| Demo account for review | Not needed — full functionality with no login |

**Review notes to paste into App Store Connect:**

> This is an offline engineering calculator for data center HVAC planning. No
> account, no network access, no data collection. All functionality is available
> immediately on launch. The chart is interactive: drag the Current and Target
> sliders, or tap the chart, to see properties update.

**Screenshots required:** 6.9" and 6.5" iPhone, 13" iPad (if iPad is enabled).
Suggested set — see the checklist below.

## Google Play

| Item | Answer |
|---|---|
| Application ID | `com.streamdatacenters.psychro` |
| Target audience | 18+ (professional tool) |
| Ads | No |
| In-app purchases | No |
| Data safety: collected | None |
| Data safety: shared | None |
| Data safety: encrypted in transit | N/A — no data transmitted |
| Data safety: deletion request | N/A — no data leaves the device |
| Government app | No |
| Content rating questionnaire | All "no" — no violence, no user interaction, no data sharing |

**Data safety declaration:** select "No data collected" and "No data shared".
The app has no `INTERNET` permission requirement beyond what the WebView shell
declares; review `android/app/src/main/AndroidManifest.xml` before submission and
remove anything not needed.

## Screenshot checklist

Capture at the default site (Goodyear, AZ) with plant rates filled in so the
timing readout is populated:

1. **Chart with a planned move** — Current and Target set, A→B line visible with
   hourly pacing points, SLA polygon shown. The primary hero shot.
2. **Compliance readout** — the Current→Target panel showing "✓ in SLA" on one
   point and a violated bound on the other, so the value proposition is legible.
3. **Properties table** — full ASHRAE property set for both points.
4. **Sensor validation** — dry-bulb/wet-bulb entry with a PASS verdict.
5. **Hall equipment panel** — plant rates and derates, showing the capacity model.
6. **Self-test panel open** — the validation table. This is the trust shot; it is
   unusual for an engineering app to show its own verification and worth leading
   with for a technical audience.

Take them from the deployed web app in a device-sized viewport, or from the
simulator/emulator once the shells run.

## Before you submit

- [ ] Bump `version` in `package.json`; it drives the in-app stamp and SW cache
- [ ] Set `versionName`/`versionCode` (Android) and `MARKETING_VERSION`/
      `CURRENT_PROJECT_VERSION` (iOS) to match
- [ ] `npm run build && npx cap sync`
- [ ] Full gate green: `npm run lint && npm run typecheck && npm test &&
      npm run verify:bundle && npm run e2e`
- [ ] Confirm the disclaimer is visible in the footer — this is a planning aid,
      not a control system
- [ ] Check `AndroidManifest.xml` and `Info.plist` for permissions the app does
      not use, and delete them; an unused permission is a review question you
      don't want
