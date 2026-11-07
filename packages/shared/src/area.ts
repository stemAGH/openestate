/**
 * Area utilities — the counterpart to `money.ts` for land measurements.
 *
 * Land area is stored as `Decimal(20, 6)` sqft canonically PLUS the pair
 * the client actually entered (`landAreaEntered`, `landAreaEnteredUnit`).
 * The entered pair is the source of truth for pricing; the sqft column
 * is a derived projection for reports, filters and sorting. See the plan
 * document (`internal plan plotted-farmhouse-inventory.md` §7.1) for the
 * two-column rationale.
 *
 * Every function here is BigInt-exact for the four integer-factor units
 * (SQFT, SQYD, GUNTA, ACRE). The only lossy path is SQM as the entered
 * or rate unit in a CROSS-unit conversion — SQM is 10.7639104167 sqft
 * (irrational) and gets rounded to 10 decimal places, matching what
 * Decimal(20, 6) can represent. When the entered unit and the rate unit
 * are BOTH SQM (or both anything else), the ratio cancels the sqft
 * factor entirely and the math is exact.
 *
 * No `decimal.js` or `big.js` dependency: this whole module lives on
 * BigInt with two documented fixed-point scales. Same discipline as
 * `money.ts` — never route area through the JS `number` type.
 */

// ── Enum ─────────────────────────────────────────────────────

export const AREA_UNITS = ['SQFT', 'SQYD', 'SQM', 'ACRE', 'GUNTA'] as const;
export type AreaUnit = (typeof AREA_UNITS)[number];

// ── Scales ───────────────────────────────────────────────────

/**
 * `landAreaEntered` is stored as `Decimal(20, 6)`. When it arrives here
 * it is normalised to a BigInt scaled by AREA_SCALE — so `0.372` becomes
 * `372_000n`. Same discipline as paise (money.ts) at 10^2, just wider.
 */
export const AREA_SCALE = 1_000_000n;

/**
 * sqft-per-unit factors, each SCALED_BY 10^10 so SQM (10.7639104167…)
 * has room without losing meaningful digits. Higher scale is not free —
 * intermediate multiplications grow — but at 10^10 the largest product
 * this module ever computes is ~10^32 which BigInt handles trivially.
 */
export const SQFT_SCALE = 10_000_000_000n;

const SQFT_PER_UNIT_SCALED: Record<AreaUnit, bigint> = {
  SQFT: 10_000_000_000n, //     1        × 10^10
  SQYD: 90_000_000_000n, //     9        × 10^10
  GUNTA: 10_890_000_000_000n, //  1_089    × 10^10
  ACRE: 435_600_000_000_000n, // 43_560   × 10^10
  // 10.7639104167 sqft/sqm — accepted rounding to 10 decimal places.
  // Only matters when SQM participates in a CROSS-unit conversion;
  // matched-unit pricing cancels this factor entirely (see §7.2).
  SQM: 107_639_104_167n,
};

// ── Public utilities ────────────────────────────────────────

/**
 * Bring an entered area value into the BigInt scaled representation
 * this module uses. Accepts either a plain number (frontend), a string
 * (Decimal.toString() from Prisma) or a bigint (already scaled).
 *
 * Rounds half-up to the nearest 10^-6, matching Decimal(20, 6)'s
 * storage precision. This is not a lossy step for anything a real
 * client enters — plot areas rarely need more than three decimal
 * places — but it is documented so a reader knows where the boundary
 * is.
 */
export function toAreaScaled(value: number | string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  const s = typeof value === 'number' ? value.toString() : value;
  const [whole, frac = ''] = s.trim().split('.');
  const sign = whole.startsWith('-') ? -1n : 1n;
  const wholeAbs = whole.replace(/^-/, '') || '0';
  // Pad or truncate the fractional part to exactly 6 digits, rounding
  // half-up when truncating.
  let fracDigits = frac.slice(0, 6).padEnd(6, '0');
  if (frac.length > 6 && Number(frac[6]) >= 5) {
    // Half-up carry through the 6-digit fractional string.
    let carry = 1;
    const arr = fracDigits.split('').reverse();
    for (let i = 0; i < arr.length && carry; i++) {
      const d = Number(arr[i]) + carry;
      arr[i] = String(d % 10);
      carry = Math.floor(d / 10);
    }
    fracDigits = arr.reverse().join('');
    if (carry) {
      // Overflow: whole part increments.
      return sign * (BigInt(wholeAbs) + 1n) * AREA_SCALE;
    }
  }
  return sign * (BigInt(wholeAbs) * AREA_SCALE + BigInt(fracDigits));
}

/** Inverse of `toAreaScaled` — returns a plain decimal string. Never used
 *  in pricing; only for display and comparison logging. */
export function fromAreaScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / AREA_SCALE;
  const frac = abs % AREA_SCALE;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '');
  const body = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${body}` : body;
}

/**
 * Convert an entered area to sqft. Exact for the four integer-factor
 * units; documented rounding for SQM (~10 decimal places).
 *
 * Used to populate `Unit.landAreaSqft` at write time — the DERIVED
 * column that reports and filters read. Pricing does NOT go through
 * this function.
 */
export function convertToSqftScaled(enteredScaled: bigint, enteredUnit: AreaUnit): bigint {
  // enteredScaled is × AREA_SCALE (10^6).
  // Result should also be × AREA_SCALE, in sqft.
  //   sqftScaled = enteredScaled × sqftPer(unit) / SQFT_SCALE
  // Half-up rounding on the final division.
  const numerator = enteredScaled * SQFT_PER_UNIT_SCALED[enteredUnit];
  return divRoundHalfUp(numerator, SQFT_SCALE);
}

/**
 * Inverse of `convertToSqftScaled` — converts the canonical sqft
 * projection back into an arbitrary display unit (e.g. a project's
 * `landAreaDefaultUnit`, for the customer portal). Display-only, like
 * `fromAreaScaled`/`formatArea` — pricing never goes through this
 * either (§7.1's "no second unit-conversion rounding" reasoning is
 * specifically about the ENTERED pair driving `baseAmountPaise`, not
 * about a read-only display value derived from the already-derived
 * sqft column).
 */
export function convertFromSqftScaled(sqftScaled: bigint, targetUnit: AreaUnit): bigint {
  const numerator = sqftScaled * SQFT_SCALE;
  return divRoundHalfUp(numerator, SQFT_PER_UNIT_SCALED[targetUnit]);
}

/**
 * The pricing function. Given a Unit's stored rate + rateUnit and
 * entered area + enteredUnit, computes the exact `baseAmountPaise`
 * that the ledger should record.
 *
 * The formula, algebraically:
 *
 *     areaInRateUnit  = landAreaEntered × sqftPer(enteredUnit) / sqftPer(rateUnit)
 *     baseAmountPaise = round( ratePaise × areaInRateUnit )
 *
 * When `enteredUnit === rateUnit`, `sqftPer` cancels — the entire path
 * is `round( ratePaise × landAreaEntered )` with no unit factor
 * involved. This is why per-sqm pricing is exact when the plot is
 * also entered as sqm: the sqft factor never enters the arithmetic.
 *
 * Everything is one BigInt multiplication followed by one BigInt
 * division with half-up rounding. Nowhere in the pipeline is a
 * floating-point number involved.
 */
export function computeBaseAmountPaise(args: {
  ratePaise: bigint;
  rateUnit: AreaUnit;
  landAreaEnteredScaled: bigint;
  landAreaEnteredUnit: AreaUnit;
}): bigint {
  const { ratePaise, rateUnit, landAreaEnteredScaled, landAreaEnteredUnit } = args;
  // numerator   = ratePaise × landAreaEntered_scaled × sqftPer(enteredUnit)_scaled
  // denominator = AREA_SCALE × sqftPer(rateUnit)_scaled
  //
  // Matched units: sqftPer(enteredUnit) === sqftPer(rateUnit) →
  // sqft factor cancels → result = ratePaise × landAreaEntered_scaled / AREA_SCALE.
  const numerator = ratePaise * landAreaEnteredScaled * SQFT_PER_UNIT_SCALED[landAreaEnteredUnit];
  const denominator = AREA_SCALE * SQFT_PER_UNIT_SCALED[rateUnit];
  return divRoundHalfUp(numerator, denominator);
}

/** Display formatter — for the UI only, never for arithmetic. */
export function formatArea(scaled: bigint, unit: AreaUnit): string {
  // Two decimal places is the norm in Indian real-estate collateral;
  // sqft plots often display integer-only.
  const isInteger = scaled % AREA_SCALE === 0n;
  const digits = isInteger ? 0 : 2;
  return `${formatFixed(scaled, digits)} ${displayLabel(unit)}`;
}

export function displayLabel(unit: AreaUnit): string {
  switch (unit) {
    case 'SQFT':
      return 'sq ft';
    case 'SQYD':
      return 'sq yd';
    case 'SQM':
      return 'sq m';
    case 'ACRE':
      return 'acre';
    case 'GUNTA':
      return 'gunta';
  }
}

// ── Internals ────────────────────────────────────────────────

/** BigInt division with half-up rounding. Same rounding money uses. */
function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error('divRoundHalfUp: division by zero');
  const negative = num < 0n !== den < 0n;
  const absNum = num < 0n ? -num : num;
  const absDen = den < 0n ? -den : den;
  const quotient = absNum / absDen;
  const remainder = absNum % absDen;
  const rounded = remainder * 2n >= absDen ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Fixed-point decimal formatter for scaled BigInt. */
function formatFixed(scaled: bigint, digits: number): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / AREA_SCALE;
  const frac = abs % AREA_SCALE;
  const fracPadded = frac.toString().padStart(6, '0');
  const truncated = fracPadded.slice(0, digits);
  const body = digits > 0 ? `${whole}.${truncated}` : whole.toString();
  return negative ? `-${body}` : body;
}
