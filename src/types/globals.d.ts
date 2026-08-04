/**
 * Build-time constants.
 *
 * Vite substitutes these at build time from package.json and git (see the
 * `define` block in vite.config.js). They exist for the type checker's
 * benefit only — nothing declares them at runtime, which is exactly why
 * src/app/version.js guards each one with `typeof … !== 'undefined'` so the
 * module still works under Vitest and any other non-Vite tooling.
 */

declare const __APP_VERSION__: string;
declare const __BUILD_SHA__: string;

/**
 * A customer contract: the envelope and the ramp limits, nothing else.
 *
 * Declared globally because three surfaces read it — the app, the door
 * placard and the briefing — and an artifact that prints a bound the profile
 * does not carry is a wrong laminated sign on a door.
 */
declare interface SlaProfile {
  name: string;
  tMinF: number;
  tMaxF: number;
  rhMin: number;
  rhMax: number;
  dpMaxF: number | null;
  maxDtHr: number;
  maxDrhHr: number;
  locked?: boolean;
}
