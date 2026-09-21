/** The same finite contract is used by the evaluator and scene builder. */
export const WORLD_CHOICES = Object.freeze({
  season: Object.freeze({
    spring: 'Pink blossom trees',
    summer: 'Green broadleaf trees',
    autumn: 'Gold and orange maple trees',
    winter: 'Evergreen forest',
  }),
  forest: Object.freeze({
    sparse: 'Open woodland',
    balanced: 'Mixed woodland',
    dense: 'Dense forest',
  }),
  settlement: Object.freeze({
    rural: 'Low village rooftops',
    town: 'Small town',
    city: 'Taller city skyline',
  }),
  weather: Object.freeze({ clear: 'Clear skies', rain: 'Rain', snow: 'Snow' }),
  time: Object.freeze({ daylight: 'Daylight', dusk: 'Dusk' }),
});

/** @typedef {{season:'spring'|'summer'|'autumn'|'winter', forest:'sparse'|'balanced'|'dense', settlement:'rural'|'town'|'city', weather:'clear'|'rain'|'snow', time:'daylight'|'dusk', seed:number}} WorldSpec */

/** @param {unknown} value @returns {WorldSpec} */
export function validateWorldSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid world plan.');
  const plan = /** @type {Record<string, unknown>} */ (value);
  if (
    Object.keys(plan).length !== 6 ||
    Object.keys(plan).some((key) => key !== 'seed' && !Object.hasOwn(WORLD_CHOICES, key))
  )
    throw new TypeError('Unknown world setting.');
  for (const [key, choices] of Object.entries(WORLD_CHOICES)) {
    if (typeof plan[key] !== 'string' || !Object.hasOwn(choices, /** @type {string} */ (plan[key])))
      throw new TypeError(`Invalid world ${key}.`);
  }
  if (
    !Number.isInteger(plan.seed) ||
    /** @type {number} */ (plan.seed) < 0 ||
    /** @type {number} */ (plan.seed) > 4294967295
  )
    throw new TypeError('Invalid world seed.');
  return { .../** @type {WorldSpec} */ (value) };
}

/** @param {string} prompt */
export function seedFromPrompt(prompt) {
  let seed = 2166136261;
  for (const character of prompt.trim().toLowerCase())
    seed = Math.imul(seed ^ (character.codePointAt(0) ?? 0), 16777619) >>> 0;
  return seed;
}

/** @param {WorldSpec} plan */
export function describeWorld(plan) {
  return Object.entries(WORLD_CHOICES)
    .map(
      ([key, choices]) =>
        /** @type {Record<string,string>} */ (choices)[
          plan[/** @type {keyof typeof WORLD_CHOICES} */ (key)]
        ],
    )
    .join(' · ');
}
