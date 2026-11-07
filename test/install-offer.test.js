/**
 * Who gets which install instructions.
 *
 * The case this exists for: iPadOS has reported a Mac user agent since
 * iPadOS 13, so a user-agent test alone sent every iPad down the desktop
 * Safari path, offering a file download instead of saying how to add the app
 * to the home screen. The banner itself is driven end to end in
 * test/e2e/launcher.spec.js.
 */

import { describe, it, expect } from 'vitest';
import { isIOS, isStandalone } from '../src/app/install-offer.js';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadOld: 'Mozilla/5.0 (iPad; CPU OS 12_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  ipadDesktopMode: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};

describe('isIOS', () => {
  it('knows an iPhone and an older iPad by their user agent', () => {
    expect(isIOS({ userAgent: UA.iphone, maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: UA.ipadOld, maxTouchPoints: 5 })).toBe(true);
  });

  it('knows a modern iPad, which calls itself a Mac, by its touch screen', () => {
    expect(isIOS({ userAgent: UA.ipadDesktopMode, maxTouchPoints: 5 })).toBe(true);
  });

  it('does not mistake a real Mac, Android or Windows for iOS', () => {
    expect(isIOS({ userAgent: UA.ipadDesktopMode, maxTouchPoints: 0 })).toBe(false);
    expect(isIOS({ userAgent: UA.ipadDesktopMode })).toBe(false);
    expect(isIOS({ userAgent: UA.android, maxTouchPoints: 5 })).toBe(false);
    expect(isIOS({ userAgent: UA.windows, maxTouchPoints: 10 })).toBe(false);
  });
});

describe('isStandalone', () => {
  const win = (matches, standalone) => /** @type {any} */ ({
    matchMedia: () => ({ matches }),
    navigator: { standalone },
  });

  it('is true in an installed app, by either signal', () => {
    expect(isStandalone(win(true, undefined))).toBe(true);
    expect(isStandalone(win(false, true))).toBe(true); // iOS home-screen app
  });

  it('is false in a browser tab', () => {
    expect(isStandalone(win(false, undefined))).toBe(false);
    expect(isStandalone(win(false, false))).toBe(false);
  });
});
