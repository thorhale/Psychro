# Operator guide — planning a hall move

For the person standing in the hall with a phone. No physics background
assumed. Everything here is a planning aid: **verify against site
instrumentation before acting.**

---

## The one question this tool answers

*Can I move my hall from where it is now to where I want it without breaking
the customer's contract — and how long will it honestly take?*

Everything else in the app supports that question.

---

## 1. Describe your hall (Data Hall card)

| Field | Why it matters |
|---|---|
| Site / elevation | Air pressure changes with altitude, and pressure changes how much water the air holds. A plan computed for sea level is wrong in Denver. |
| Measured pressure (optional) | If the hall has a barometer, type the reading. It beats the elevation estimate, which is worth about ±2 kPa against real weather. |
| Hall air volume | The tool weighs the actual air in the room to work out how much water must be added or removed. Without the volume it cannot time moisture work — and it will tell you so rather than guess. |
| Cooling / warming rate (°F per hour) | What your plant really delivers, not the nameplate. Commissioning numbers are ideal. |
| Dehumidify / humidify rate (lb per hour) | Same idea for moisture. Enter net capacity — nameplate minus whatever the outside-air load is already eating. |
| Efficiency % | How much of nameplate this hall actually achieves. Start at 85 %. Later, the plan-vs-actual feature can measure it for you. |

**If you only fill in one thing, make it the volume and the rates.** Without
them the app can still draw the physics, but it will refuse to promise a
duration — which is the honest answer, not a limitation.

## 2. Set the contract (Customer SLA card)

Type the customer's limits: temperature range, humidity range, the dew-point
cap, and how fast you're allowed to change things (°F per hour). The chart
draws this as a box you must stay inside. The Base SLA is locked as a
reference; press **+ Add** to make your own copy and edit that.

Everything here is entered in whatever unit you've selected at the top — °F,
°C or K — and stored consistently underneath.

## 3. Plan the move (Conditions card)

Set **Current** to what the hall reads now, **Target** to where you want it.
Then read three things:

1. **The two badges** — is each point inside the contract? If not, the badge
   names the limit that's broken, in your units.
2. **The advisory** — the earliest honest finish time, and *which* constraint
   is holding you back (your plant, or the customer's ramp limit). If plant
   rates are missing it says so instead of inventing a number.
3. **The chart** — Current and Target with the plan line between them, tick
   marks showing where the hall should be at each hour, and the SLA box plus
   the ASHRAE envelopes around them.

Tap **Copy briefing** to put the whole thing on the clipboard as plain
English — including an hour-by-hour set-point ladder — ready to paste into a
change ticket.

## 4. Trust, but verify (Sensor Validation card)

A plan is only as good as the sensor that told you where you are. Six ways to
check one against something physical:

| Method | Use when |
|---|---|
| **Ice point** | Always. A proper ice slurry is 0.00 °C by definition — the cheapest trustworthy check that exists. |
| **Salt chamber** | The gold standard for humidity. A sealed jar of table-salt slurry sits at 75.3 %RH by physical chemistry. It cannot drift or expire. |
| **Boiling point** | A second temperature point above ambient, corrected for your altitude (water does *not* boil at 212 °F in Denver). Catches gross errors, not tenths. |
| **Psychrometer** | You have a sling psychrometer and moving air. |
| **Dew-point meter** | The site owns a chilled-mirror instrument. |
| **Reference instrument** | Fast spot check against something recently calibrated — exactly as good as its paperwork. |

Verdicts are deliberately cautious: to say **PASS**, the sensor's error must
be inside tolerance *by more than your reference's own uncertainty*. When it
isn't, you get **TOO CLOSE TO CALL** — the reference can't decide, so use a
better one. That's a feature.

Name the sensor, press **Log check**, and it starts a history: drift per
month, an estimate of when it will need recalibrating, and — if you enter a
check-every-N-days cadence — an overdue warning on the card itself. The whole
logbook exports as CSV for QA packs.

## 5. After the move — did it go to plan? (Data Hall → plan vs actual)

Export the trend from your BMS as CSV and import it. The real trajectory
overlays the chart next to your plan, the app reports the fastest sustained
ramp and checks it against the SLA limit, and one tap logs the measured
duration so your efficiency figure gets better every time.

## 6. Things worth printing

- **Door placard** (Export → placard): one page, black on white, with the
  do-not-cross numbers, the envelope chart, and a QR code that opens the
  planner at this hall's set-points. Laminate it.
- **Chart PNG / PDF** for the change record.

---

## Practice without risk (Training card)

The Envelope Escape Room throws a plant fault at a standard hall — stuck
humidifier, chiller down, cold snap, dehumidifier tagged out — and scores how
much SLA time your recovery keeps. Two truths it will teach you quickly:

- **The servers never stop.** An uncommanded hall drifts warm on its own.
  "Wait and see" is a decision, and it costs.
- **The plant takes minutes to respond.** Committing early beats committing
  perfectly.

Share a challenge code and compete on the identical fault.

---

## Glossary

Open **Plain-English glossary** in the app — every derived number the tool
shows, explained without jargon.
