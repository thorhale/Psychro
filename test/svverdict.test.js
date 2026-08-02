/**
 * Guard-banded verdict grading (ISO 14253-1): PASS must clear the tolerance
 * by the reference's uncertainty, FAIL must clear the recalibrate band by it,
 * and the straddle zone says so instead of picking a side.
 */

import { describe, it, expect } from 'vitest';
import { svVerdict, SV_TOL } from '../src/core/svverdict.js';

describe('svVerdict', () => {
  it('with a perfect reference (u=0) the bands are the plain tolerances', () => {
    expect(svVerdict(1.9, 2, 5, 0).word).toBe('PASS');
    expect(svVerdict(2.0, 2, 5, 0).word).toBe('PASS'); // inclusive at the limit
    expect(svVerdict(2.1, 2, 5, 0).word).toBe('MARGINAL');
    expect(svVerdict(5.0, 2, 5, 0).word).toBe('MARGINAL');
    expect(svVerdict(5.1, 2, 5, 0).word).toBe('FAIL');
  });

  it('a worse reference makes PASS harder, never easier', () => {
    // err 1.7 against tol 2: passes with a ±0.2 reference, undecidable with ±0.5.
    expect(svVerdict(1.7, 2, 5, 0.2).word).toBe('PASS');
    expect(svVerdict(1.7, 2, 5, 0.5).word).toBe('TOO CLOSE TO CALL');
    // The old (backwards) rule graded err 2.3 with u=0.5 as PASS (2+0.5 band).
    expect(svVerdict(2.3, 2, 5, 0.5).word).not.toBe('PASS');
  });

  it('the straddle zone is exactly tol ± u, boundaries inclusive outward', () => {
    const u = 0.4;
    expect(svVerdict(1.6, 2, 5, u).word).toBe('PASS'); //           = tol − u
    expect(svVerdict(1.61, 2, 5, u).word).toBe('TOO CLOSE TO CALL');
    expect(svVerdict(2.4, 2, 5, u).word).toBe('TOO CLOSE TO CALL'); // = tol + u
    expect(svVerdict(2.41, 2, 5, u).word).toBe('MARGINAL');
    const v = svVerdict(2.0, 2, 5, u);
    expect(v.indet).toBe(true);
    expect(v.cls).toBe('sv-indet');
  });

  it('FAIL is also guard-banded: confidently out means out by more than u', () => {
    expect(svVerdict(5.3, 2, 5, 0.4).word).toBe('MARGINAL'); // 5.3 ≤ 5.4
    expect(svVerdict(5.5, 2, 5, 0.4).word).toBe('FAIL');
  });

  it('a reference as uncertain as the tolerance can never certify a PASS', () => {
    // The boiling-point check's real situation: u = tol = 0.9 °F. Only an
    // exactly-zero error "passes" (pass band collapses to 0); everything up
    // to 1.8 is undecidable. Gross errors still FAIL — that is the method's
    // honest role.
    expect(svVerdict(0, 0.9, 1.8, 0.9).word).toBe('PASS');
    expect(svVerdict(0.3, 0.9, 1.8, 0.9).word).toBe('TOO CLOSE TO CALL');
    expect(svVerdict(4, 0.9, 1.8, 0.9).word).toBe('FAIL');
  });

  it('sign does not matter — errors grade by magnitude', () => {
    expect(svVerdict(-1.5, 2, 5, 0.4).word).toBe(svVerdict(1.5, 2, 5, 0.4).word);
    expect(svVerdict(-6, 2, 5, 0.4).word).toBe('FAIL');
  });

  it('no reading, no verdict', () => {
    expect(svVerdict(null, 2, 5, 0.4)).toBeNull();
    expect(svVerdict(NaN, 2, 5, 0.4)).toBeNull();
    expect(svVerdict(Infinity, 2, 5, 0.4)).toBeNull();
  });

  it('exports the default tolerance bands the UI documents', () => {
    expect(SV_TOL).toEqual({ rhPass: 2, rhMarginal: 5, tPassF: 0.9, tMarginalF: 1.8 });
  });
});
