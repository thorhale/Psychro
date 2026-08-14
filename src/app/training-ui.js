/**
 * Training mode — the Envelope Escape Room.
 *
 * A drill, not a planner: the operator is dropped into a hall that is drifting
 * out of contract and has to command it back before it breaches. The referee
 * that scores a run is pure and lives in src/core/trainer.js; everything here
 * is the surface around it — the brief, the sparkline, the challenge code.
 *
 * Deliberately isolated from the rest of the app: the training hall is FIXED
 * (same volume, same plant, same SLA, same sea-level pressure for everyone),
 * so a challenge code reproduces an identical run on any device anywhere. It
 * reads none of the operator's real halls and writes none of them.
 */

import { toast, copyText } from '../ui/notify.js';
import { tU, tLabel, dispT1 } from '../ui/format.js';
import { checkSLA as checkSLACore } from '../core/envelopes.js';
import { SCENARIOS, refereeRun, TRAINER_VERSION } from '../core/trainer.js';
import { inp, canvasEl } from '../ui/dom.js';

// The training hall is FIXED — same volume, same plant rates, same SLA, same
// standard sea-level pressure for everyone — so a challenge code reproduces
// the identical run on any device, anywhere. These constants are mirrored in
// test/trainer.test.js, which proves every scenario is winnable with them.
const TRAINING_HALL = { hallVolFt3: 200000, rateCoolF: 6, rateWarmF: 4, rateDehumLb: 100, rateHumLb: 80 };
const TRAINING_SLA = { name: 'Training SLA', tMinF: 59, tMaxF: 89.6, rhMin: 8, rhMax: 80, dpMaxF: 62.6 };
const TRAINING_P = 101.325; // kPa — standard atmosphere, deliberately not the site's

const trState = { scenarioId: SCENARIOS[0].id, seed: 42 };

const trCheckSla = (tempF, rh) => {
  // Explicitly sea level, like everything else in the drill — a challenge
  // code has to score the same for a colleague in Denver.
  const v = checkSLACore(TRAINING_SLA, tempF, rh, TRAINING_P);
  return { ok: v.ok, detail: v.detail };
};

const trScenario = () =>
  SCENARIOS.find((s) => s.id === trState.scenarioId) || SCENARIOS[0];

export function renderTrainingBrief() {
  const el = inp('tr-brief');
  if (!el) return;
  const s = trScenario();
  el.innerHTML =
    `<strong>${s.title}.</strong> ${s.brief}<br>` +
    `<span class="cap-hint">Hall starts at ${dispT1(s.start.tempF)} ${tLabel()} / ${s.start.rh}% RH · ` +
    `fault seed ${trState.seed} · the referee runs ${s.simHours} hours.</span>`;
  const share = inp('tr-share');
  if (share) share.style.display = '';
  const sum = inp('tr-summary');
  if (sum) sum.textContent = `${s.title} · seed ${trState.seed}`;
}

/** A new scenario or seed is a new challenge — clear the old run's verdict. */
function trNewChallenge() {
  renderTrainingBrief();
  const res = inp('tr-result');
  if (res) res.style.display = 'none';
  const spark = inp('tr-spark');
  if (spark) spark.style.display = 'none';
}

/** Draw the run's temp + RH traces, with the breach minute marked in red. */
function drawTrainingSpark(r) {
  const canvas = canvasEl('tr-spark');
  if (!canvas) return;
  canvas.style.display = 'block';
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(200, canvas.clientWidth || 600);
  const H = 70;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const n = r.trail.length;
  const x = (i) => (i / (n - 1)) * W;
  const line = (get, lo, hi, color) => {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const y = H - 4 - ((get(r.trail[i]) - lo) / (hi - lo || 1)) * (H - 8);
      if (i === 0) ctx.moveTo(x(i), y);
      else ctx.lineTo(x(i), y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };
  const temps = r.trail.map((s) => s.tempF);
  const tLo = Math.min(...temps) - 1;
  const tHi = Math.max(...temps) + 1;
  // Everything in-SLA before the breach reads green context; after, red tint.
  if (r.breachedAtMin != null) {
    ctx.fillStyle = 'rgba(220, 60, 60, 0.12)';
    ctx.fillRect(x(r.breachedAtMin), 0, W - x(r.breachedAtMin), H);
    ctx.strokeStyle = 'rgba(220, 60, 60, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(r.breachedAtMin), 0);
    ctx.lineTo(x(r.breachedAtMin), H);
    ctx.stroke();
  }
  line((s) => s.tempF, tLo, tHi, '#e08a3c'); //  temperature, warm orange
  line((s) => s.rh, 0, 100, '#3ca7a0'); //       RH on its natural 0–100 scale
}

function runTraining(target) {
  const s = trScenario();
  const r = refereeRun({
    scenario: s,
    seed: trState.seed,
    target,
    hall: TRAINING_HALL,
    checkSla: trCheckSla,
    pressure: TRAINING_P,
  });
  const res = inp('tr-result');
  if (!res) return;
  const maxScore = r.totalMinutes + 30;
  let verdict;
  if (r.breachedAtMin == null) {
    verdict =
      `<span class="sv-pass">SURVIVED</span> — the hall stayed inside the SLA for all ` +
      `${r.totalMinutes} minutes${r.stabilized ? ' and finished stable' : ', but was still moving at the end'}.`;
  } else {
    const hh = Math.floor(r.breachedAtMin / 60);
    const mm = r.breachedAtMin % 60;
    verdict =
      `<span class="sv-fail">BREACHED</span> at minute ${r.breachedAtMin}` +
      ` (${hh ? `${hh} h ` : ''}${mm} min in) — ${r.breachDetail}. ` +
      `In SLA ${r.minutesInSla} of ${r.totalMinutes} minutes.`;
  }
  const what = target
    ? `Committed target: ${dispT1(target.tempF)} ${tLabel()} / ${target.rh}% RH.`
    : 'No target committed — the plant never fought back. That is what hesitation costs.';
  res.innerHTML =
    `${verdict}<br>${what}<br>` +
    `<strong>Score ${r.score} / ${maxScore}</strong> ` +
    `<span class="cap-hint">(one point per SLA-minute${r.stabilized && r.breachedAtMin == null ? ' + 30 stability bonus' : ''}; ` +
    `orange = temperature, teal = RH)</span>`;
  res.style.display = '';
  drawTrainingSpark(r);
}

/** Challenge code: the hall is fixed, so version + scenario + seed is the
 *  whole game — the version pins WHICH referee's physics scored it. */
function trainingShareUrl() {
  const base = location.protocol.startsWith('http')
    ? location.href.split('#')[0]
    : 'https://thorhale.github.io/Psychro/';
  return `${base}#train=v${TRAINER_VERSION}.${trState.scenarioId}.${trState.seed}`;
}

/** Open a challenge code at boot. Returns true when one was applied. */
export function applyTrainingFromUrl() {
  const m = /[#&]train=(?:v(\d+)\.)?([a-z][a-z-]*)\.(\d{1,9})\b/.exec(location.hash || '');
  if (!m) return false;
  const s = SCENARIOS.find((x) => x.id === m[2]);
  if (!s) return false;
  // A code minted by a different referee still runs — on TODAY'S physics,
  // with a plain warning. Keeping old physics engines around would mean two
  // sources of truth; a flagged re-score is the honest alternative.
  const codeVer = m[1] ? parseInt(m[1], 10) : 1;
  if (codeVer !== TRAINER_VERSION) {
    toast(
      `This challenge code was made with an older version of the referee — it will run on today's physics, so scores may differ from the original.`,
      { kind: 'warn', duration: 9000 },
    );
  }
  trState.scenarioId = s.id;
  trState.seed = parseInt(m[3], 10);
  const sel = inp('tr-scenario');
  if (sel) sel.value = s.id;
  const seedEl = inp('tr-seed');
  if (seedEl) seedEl.value = String(trState.seed);
  renderTrainingBrief();
  const details = sel?.closest('details');
  if (details) {
    details.open = true;
    details.scrollIntoView({ block: 'start' });
  }
  toast(`Challenge accepted: "${s.title}", seed ${trState.seed}. Commit your recovery.`, {
    kind: 'info',
    duration: 8000,
  });
  return true;
}

(function initTraining() {
  const sel = inp('tr-scenario');
  if (!sel) return;
  sel.innerHTML = SCENARIOS.map((s) => `<option value="${s.id}">${s.title}</option>`).join('');
  sel.value = trState.scenarioId;
  sel.addEventListener('change', () => {
    trState.scenarioId = sel.value;
    trNewChallenge();
  });
  inp('tr-seed')?.addEventListener('input', function () {
    const v = parseInt(this.value, 10);
    trState.seed = isNaN(v) || v < 0 ? 0 : Math.min(999999999, v);
    trNewChallenge();
  });
  inp('tr-reroll')?.addEventListener('click', () => {
    trState.seed = Math.floor(Math.random() * 100000);
    const seedEl = inp('tr-seed');
    if (seedEl) seedEl.value = String(trState.seed);
    trNewChallenge();
  });
  inp('tr-commit')?.addEventListener('click', () => {
    const tv = parseFloat(inp('tr-temp')?.value);
    const rv = parseFloat(inp('tr-rh')?.value);
    if (isNaN(tv) || isNaN(rv)) {
      toast('Enter both a target temperature and a target RH first.', { kind: 'warn' });
      return;
    }
    runTraining({ tempF: tU().toF(tv), rh: Math.min(99, Math.max(1, rv)) });
  });
  inp('tr-idle')?.addEventListener('click', () => runTraining(null));
  inp('tr-share')?.addEventListener('click', () => {
    copyText(trainingShareUrl(), 'Challenge code');
  });
  renderTrainingBrief();
})();
