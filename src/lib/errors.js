/**
 * Error capture: a ring buffer of recent errors plus global handlers, so field
 * problems leave a trail an engineer can read from the footer instead of
 * vanishing into `catch (e) {}`.
 *
 * Nothing leaves the device — the log lives in memory and can be copied to the
 * clipboard from the error panel. That matches the app's "no data leaves the
 * phone" guarantee.
 */

const MAX_ENTRIES = 50;

/** @type {{time: string, context: string, message: string, stack?: string}[]} */
const ring = [];

/** @type {((count: number) => void) | null} */
let onChange = null;

/** Record an error with the context it happened in. */
export function logError(context, err) {
  const entry = {
    time: new Date().toISOString(),
    context,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) ring.shift();
  // Always echo to the console — free diagnostics when a DevTools is attached.
  console.error(`[${context}]`, err);
  if (onChange) onChange(ring.length);
}

/** Snapshot of the current log, newest last. */
export function getErrorLog() {
  return ring.slice();
}

export function clearErrorLog() {
  ring.length = 0;
  if (onChange) onChange(0);
}

/** Register a listener for log growth (the footer badge). */
export function onErrorLogChange(fn) {
  onChange = fn;
}

/**
 * Run `fn`, logging rather than propagating any exception.
 * For event handlers and best-effort work where v1 used empty catches —
 * the failure is still visible in the log instead of silently swallowed.
 * @template T
 * @param {string} context
 * @param {() => T} fn
 * @param {T} [fallback]
 * @returns {T | undefined}
 */
export function safe(context, fn, fallback) {
  try {
    return fn();
  } catch (err) {
    logError(context, err);
    return fallback;
  }
}

/** Install window-level handlers so uncaught errors reach the ring buffer too. */
export function installGlobalHandlers() {
  window.addEventListener('error', (e) => {
    logError('uncaught', e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    logError('unhandled-promise', e.reason ?? 'unknown rejection');
  });
}

/** Render the log as copyable text for a support hand-off. */
export function formatErrorLog() {
  if (!ring.length) return 'No errors recorded this session.';
  return ring
    .map((e) => `${e.time}  [${e.context}]  ${e.message}${e.stack ? '\n' + e.stack : ''}`)
    .join('\n\n');
}
