import { describe, it, expect } from 'vitest';
import { explain, type ExplainInput } from '../../src/lib/engine/explain';

const base: ExplainInput = {
  instrumentType: 'STOCK',
  band: 'LOW',
  shareReference: 0.9,
  referenceReturn: -0.032,
  instrumentReturn: -0.037,
  z: 0.2,
  idioVol: 0.012,
};

describe('a card only explains a move worth explaining', () => {
  it('says nothing is happening when the move is inside ordinary daily noise', () => {
    // Found by reading real output: a stock that drifted 0.4% on a flat day is
    // genuinely "88% stock-specific", and saying so is technically true and
    // completely misleading. It reads as an alarm about nothing.
    const line = explain({ ...base, instrumentReturn: -0.004, shareReference: 0.12, z: -0.29 });
    expect(line).toBe('Moving normally. Nothing unusual today.');
  });

  it('does explain once the move exceeds that noise', () => {
    const line = explain(base);
    expect(line).toMatch(/90% of this move is the market/);
    expect(line).not.toMatch(/Nothing unusual/);
  });

  it('still explains a large move even when conviction is low', () => {
    // The contradiction card depends on this: a big fall that is mostly market
    // must say so rather than going quiet.
    const line = explain({ ...base, instrumentReturn: -0.037, shareReference: 0.95, z: 0.18 });
    expect(line).toMatch(/95% of this move is the market/);
    expect(line).toMatch(/only 5% is the stock itself/);
  });
});

describe('numbers are rendered honestly', () => {
  it('never prints a negative zero', () => {
    // "-0.0%" looks like a bug and undermines every other number on the card.
    const line = explain({
      ...base,
      band: 'EXTREME',
      referenceReturn: -0.00001,
      instrumentReturn: 0.065,
      shareReference: 0,
      z: 4.26,
    });
    expect(line).not.toMatch(/-0\.0%/);
    expect(line).toMatch(/moved 0\.0%/);
  });

  it('starts the second sentence with a capital letter', () => {
    const line = explain({ ...base, band: 'EXTREME', instrumentReturn: 0.065, shareReference: 0, z: 4.26 });
    expect(line).toMatch(/\. The market moved/);
  });

  it('signs a meaningful reference move', () => {
    expect(explain(base)).toMatch(/\(-3\.2%\)/);
    expect(explain({ ...base, referenceReturn: 0.021, instrumentReturn: 0.03 })).toMatch(/\(\+2\.1%\)/);
  });
});

describe('funds are described as funds', () => {
  it('talks about a benchmark, never about the market', () => {
    const line = explain({ ...base, instrumentType: 'FUND', instrumentReturn: -0.031, shareReference: 0.99 });
    expect(line).toMatch(/its benchmark/);
    expect(line).toMatch(/Tracking, not diverging/);
    expect(line).not.toMatch(/the market/);
  });

  it('calls an extreme fund move the fund, not the stock', () => {
    const line = explain({
      ...base,
      instrumentType: 'FUND',
      band: 'EXTREME',
      instrumentReturn: 0.04,
      shareReference: 0.1,
      z: 3.1,
    });
    expect(line).toMatch(/the fund itself/);
    expect(line).not.toMatch(/stock/);
  });
});
