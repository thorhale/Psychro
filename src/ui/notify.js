/**
 * Non-blocking notifications: toasts and a promise-based confirm dialog.
 *
 * Replaces every `alert()` / `confirm()` in the v1 tool. Blocking dialogs are
 * jarring inside a native webview (Capacitor round 2) and freeze the chart's
 * rAF loop; these do neither. Injects its own styles and container lazily, so
 * importing the module costs nothing until the first toast.
 */

let host = null;

function ensureHost() {
  if (host) return host;
  const style = document.createElement('style');
  style.textContent = `
  .ntf-host { position: fixed; left: 0; right: 0; bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    display: flex; flex-direction: column; align-items: center; gap: 8px; z-index: 9999; pointer-events: none; }
  .ntf-toast { pointer-events: auto; max-width: min(92vw, 480px); padding: 10px 16px; border-radius: 8px;
    font: 600 .82rem -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #e6edf3;
    background: #1f3a52; border: 1px solid #2c4a66; box-shadow: 0 4px 24px rgba(0,0,0,.45);
    opacity: 0; transform: translateY(8px); transition: opacity .18s, transform .18s; }
  .ntf-toast.show { opacity: 1; transform: none; }
  .ntf-toast.ntf-ok { border-color: rgba(63,185,80,.5); }
  .ntf-toast.ntf-warn { border-color: rgba(240,165,0,.6); }
  .ntf-toast.ntf-error { border-color: rgba(248,81,73,.6); background: #3a1f24; }
  .ntf-toast button { margin-left: 12px; padding: 4px 10px; border-radius: 6px; border: 1px solid #2c4a66;
    background: #13263a; color: var(--brand-accent, #10a8c6); font: inherit; cursor: pointer; }
  .ntf-scrim { position: fixed; inset: 0; background: rgba(4,10,18,.6); z-index: 9998;
    display: flex; align-items: center; justify-content: center; padding: 20px; }
  .ntf-dialog { background: #13263a; border: 1px solid #2c4a66; border-radius: 10px; padding: 18px;
    max-width: 420px; width: 100%; color: #e6edf3; font: .86rem -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .ntf-dialog h3 { margin: 0 0 8px; font-size: .95rem; }
  .ntf-dialog p { margin: 0 0 16px; color: #9db8d0; line-height: 1.45; }
  .ntf-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .ntf-actions button { padding: 8px 16px; border-radius: 7px; border: 1px solid #2c4a66;
    background: #1f3a52; color: #e6edf3; font: 600 .8rem inherit; cursor: pointer; }
  .ntf-actions button.ntf-primary { background: var(--brand-accent, #10a8c6); border-color: var(--brand-accent, #10a8c6); color: #04121e; }
  .ntf-actions button.ntf-danger { background: #f85149; border-color: #f85149; color: #fff; }
  `;
  document.head.appendChild(style);
  host = document.createElement('div');
  host.className = 'ntf-host';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

/**
 * Show a toast.
 * @param {string} message
 * @param {{kind?: 'info'|'ok'|'warn'|'error', duration?: number, // 0 = sticky
 *          action?: {label: string, onClick: () => void}}} [opts]
 */
export function toast(message, opts = {}) {
  const h = ensureHost();
  const el = document.createElement('div');
  el.className = `ntf-toast ntf-${opts.kind ?? 'info'}`;
  el.textContent = message;
  if (opts.action) {
    const btn = document.createElement('button');
    btn.textContent = opts.action.label;
    btn.addEventListener('click', () => {
      opts.action.onClick();
      dismiss();
    });
    el.appendChild(btn);
  }
  h.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  // duration: 0 means STICKY — stay until acted on or clicked away. Used for
  // the "a new version is ready" prompt, which is worthless if it vanishes
  // while someone is looking at the chart. Without this branch a 0 would be
  // passed straight to setTimeout and dismiss the toast on the next tick.
  const ttl = opts.duration ?? (opts.kind === 'error' ? 8000 : 4500);
  const timer = ttl > 0 ? setTimeout(dismiss, ttl) : 0;
  function dismiss() {
    if (timer) clearTimeout(timer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }
  el.addEventListener('click', (e) => {
    if (e.target === el) dismiss();
  });
  return dismiss;
}

/**
 * Modal that shows a rendered canvas (QR codes) with a title and note.
 * Same look/roles as confirmDialog; resolves when dismissed.
 * @param {{title:string, note?:string, render:(canvas:HTMLCanvasElement)=>void}} opts
 * @returns {Promise<void>}
 */
export function imageDialog(opts) {
  ensureHost();
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'ntf-scrim';
    const dlg = document.createElement('div');
    dlg.className = 'ntf-dialog';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');

    const h3 = document.createElement('h3');
    h3.textContent = opts.title;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;margin:12px auto;image-rendering:pixelated;max-width:100%;';
    opts.render(canvas);
    const p = document.createElement('p');
    if (opts.note) p.textContent = opts.note;
    const actions = document.createElement('div');
    actions.className = 'ntf-actions';
    const ok = document.createElement('button');
    ok.textContent = 'Close';
    ok.className = 'ntf-primary';

    const close = () => {
      scrim.remove();
      document.removeEventListener('keydown', onKey);
      resolve();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    ok.addEventListener('click', close);
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) close();
    });

    actions.appendChild(ok);
    dlg.append(h3, canvas, ...(opts.note ? [p] : []), actions);
    scrim.appendChild(dlg);
    document.body.appendChild(scrim);
    ok.focus();
  });
}

/**
 * Copy text to the clipboard with user feedback — the one shared path for
 * every copy action, so the toast wording and the no-clipboard fallback
 * cannot drift between features.
 * @param {string} text
 * @param {string} [what] label for the toast, e.g. 'Link'
 * @returns {Promise<boolean>} whether the copy succeeded
 */
export async function copyText(text, what = 'Text') {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied to clipboard.`, { kind: 'ok' });
    return true;
  } catch {
    toast('Could not access the clipboard on this device.', { kind: 'warn' });
    return false;
  }
}

/**
 * Promise-based confirm dialog — non-blocking replacement for `confirm()`.
 * @param {{title: string, message: string, confirmLabel?: string,
 *          danger?: boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog(opts) {
  ensureHost();
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'ntf-scrim';
    const dlg = document.createElement('div');
    dlg.className = 'ntf-dialog';
    dlg.setAttribute('role', 'alertdialog');
    dlg.setAttribute('aria-modal', 'true');

    const h3 = document.createElement('h3');
    h3.textContent = opts.title;
    const p = document.createElement('p');
    p.textContent = opts.message;
    const actions = document.createElement('div');
    actions.className = 'ntf-actions';

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.textContent = opts.confirmLabel ?? 'OK';
    ok.className = opts.danger ? 'ntf-danger' : 'ntf-primary';

    const close = (result) => {
      scrim.remove();
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };

    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) close(false);
    });
    document.addEventListener('keydown', onKey);

    actions.append(cancel, ok);
    dlg.append(h3, p, actions);
    scrim.appendChild(dlg);
    document.body.appendChild(scrim);
    ok.focus();
  });
}
