import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Enforces the integrity rule mechanically rather than by good intentions.
 *
 * The conviction engine must estimate beta and idiosyncratic volatility by
 * regression from observed price history, exactly as it would against a real
 * market feed. If it imported the simulator's generator parameters it would be
 * reading its own answer key: the maths would be circular, and a sharp judge
 * would find it in one question (D-012).
 *
 * Code review catches this once. A test catches it every time, including at
 * hour 47 when someone is tired and reaches for a convenient import.
 */

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('the engine cannot read the simulator answer key', () => {
  const engineDir = join(process.cwd(), 'src', 'lib', 'engine');
  const files = walk(engineDir);

  it('has engine files to check, so the test cannot silently pass on an empty set', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const rel = file.replace(process.cwd(), '').replace(/\\/g, '/');
    it(`${rel} does not import simulator parameters`, () => {
      const src = readFileSync(file, 'utf8');
      // Any path ending in sim/params, however it is spelled or aliased.
      const offending = /from\s+['"][^'"]*sim\/params['"]|require\(\s*['"][^'"]*sim\/params['"]/;
      expect(src).not.toMatch(offending);
    });
  }

  it('does not reach the parameters transitively through the simulator either', () => {
    // Importing anything from src/lib/sim into the engine would be a smell: the
    // engine consumes the database, never the generator.
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/from\s+['"][^'"]*\/sim\//);
    }
  });
});
