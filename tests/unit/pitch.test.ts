import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The pitch is a submission deliverable and the first thing a judge reads, and
 * it is easy to break by hand: a word added in an editor stops it being a
 * hundred words, and a stray quote marker survives a paste into a form field.
 *
 * This asserts the properties that must hold, in the same spirit as D-068,
 * which enforces the answer-key rule with a test rather than good intentions.
 *
 * It used to assert a second copy in `docs/DESIGN.md` section 0.4 matched this
 * one. That section no longer exists: DESIGN.md was rewritten as a design
 * document, and a submission artifact is not design (D-143). With one copy
 * there is nothing to drift, so the assertion was removed rather than pointed
 * somewhere else -- a test enforcing a relationship that no longer exists
 * reports safety it is not checking (D-124).
 */

const ROOT = process.cwd();

/** Words as a human counts them, which is what "100-word pitch" means. */
function wordsOf(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function pitch(): string {
  const md = readFileSync(join(ROOT, 'PITCH.md'), 'utf8').replace(/\r\n/g, '\n');
  const match = md.match(/<!-- pitch:start -->\n([\s\S]*?)\n<!-- pitch:end -->/);
  if (!match) throw new Error('PITCH.md has lost its pitch:start / pitch:end markers');
  return match[1].trim();
}

describe('the 100-word pitch', () => {
  it('is exactly 100 words', () => {
    expect(wordsOf(pitch())).toHaveLength(100);
  });

  it('pastes as a single paragraph, with no markdown quote markers', () => {
    expect(pitch()).not.toContain('\n');
    expect(pitch()).not.toContain('>');
  });

  it('has no spaced dash, which a form field would count as a word', () => {
    // Three rewrites overshot by one or two words because an em dash counts as
    // a token to some counters and not others. Removing them entirely means any
    // counter agrees with this one.
    expect(pitch()).not.toMatch(/\s[—–-]\s/);
  });
});
