import { experimental_evaluate } from 'ai';

export const MODEL = 'typesafe-ai/jev';
export const REGIONS = ['gorge', 'terraces', 'village', 'shrine', 'bridge', 'station', 'city'];
const PACES = ['relaxed', 'cruise', 'cautious'];
const ACTIVITIES = ['commute', 'shelter', 'stroll'];

/** @typedef {{weather:'clear'|'rain'|'snow', speedKmh:number, remainingToStation:number, region:'gorge'|'terraces'|'village'|'shrine'|'bridge'|'station'|'city', paused:boolean}} DirectorInput */
/** @typedef {{pace:'relaxed'|'cruise'|'cautious', stationActivity:'commute'|'shelter'|'stroll'}} Decision */
/** @typedef {{source:'jev'|'fallback', reason:string, decision:Decision}} DirectorResult */
/** @typedef {(input:Parameters<typeof experimental_evaluate>[0])=>Promise<unknown>} Evaluator */

export class DirectorError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
const record = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} input @returns {DirectorInput} */
export function validateInput(input) {
  if (!record(input)) throw new DirectorError(400, 'Expected a JSON object.');
  const fields = ['weather', 'speedKmh', 'remainingToStation', 'region', 'paused'];
  if (
    Object.keys(input).length !== fields.length ||
    Object.keys(input).some((key) => !fields.includes(key))
  )
    throw new DirectorError(
      400,
      'Only weather, speedKmh, remainingToStation, region, and paused are accepted.',
    );
  if (typeof input.weather !== 'string' || !['clear', 'rain', 'snow'].includes(input.weather))
    throw new DirectorError(400, 'Unsupported weather.');
  if (
    typeof input.speedKmh !== 'number' ||
    !Number.isFinite(input.speedKmh) ||
    input.speedKmh < 0 ||
    input.speedKmh > 160
  )
    throw new DirectorError(400, 'speedKmh must be between 0 and 160.');
  if (
    typeof input.remainingToStation !== 'number' ||
    !Number.isFinite(input.remainingToStation) ||
    input.remainingToStation < -5000 ||
    input.remainingToStation > 5000
  )
    throw new DirectorError(400, 'remainingToStation must be between -5000 and 5000 metres.');
  if (typeof input.region !== 'string' || !REGIONS.includes(input.region))
    throw new DirectorError(400, 'Unsupported region.');
  if (typeof input.paused !== 'boolean') throw new DirectorError(400, 'paused must be boolean.');
  return /** @type {DirectorInput} */ ({
    weather: input.weather,
    speedKmh: input.speedKmh,
    remainingToStation: input.remainingToStation,
    region: input.region,
    paused: input.paused,
  });
}

/** @param {DirectorInput} input @param {string} reason @returns {DirectorResult} */
export function fallback(input, reason) {
  const nearStation = input.remainingToStation >= 0 && input.remainingToStation < 250;
  const cautious = input.weather !== 'clear' || nearStation || input.speedKmh > 125;
  return {
    source: 'fallback',
    reason,
    decision: {
      pace: input.paused
        ? 'relaxed'
        : cautious
          ? 'cautious'
          : ['gorge', 'shrine', 'bridge'].includes(input.region)
            ? 'relaxed'
            : 'cruise',
      stationActivity:
        input.weather !== 'clear'
          ? 'shelter'
          : ['station', 'city'].includes(input.region)
            ? 'commute'
            : 'stroll',
    },
  };
}

/** @type {Record<string, import('ai').Experimental_EvaluationQuestion>} */
const questions = {
  pace: {
    type: 'choice',
    instructions:
      'Choose the sightseeing autopilot pace for this fictional train game. This choice never overrides player controls, emergency braking, or terminal protection. Prefer cautious near a station, in rain or snow, or above 125 km/h. Prefer relaxed for a scenic gorge, bridge or shrine; otherwise cruise. If paused, prefer relaxed.',
    criteria: {
      relaxed: 'Slow scenic sightseeing',
      cruise: 'Ordinary clear-weather running',
      cautious: 'Reduced pace for weather or station approach',
    },
  },
  stationActivity: {
    type: 'choice',
    instructions:
      'Choose a background station crowd routine. Prefer shelter during rain or snow, commute at a city or station in clear weather, and stroll for the other countryside regions. This is visual background activity, not permission to open doors or enter the track.',
    criteria: {
      commute: 'People wait for a train on the platform',
      shelter: 'People wait under the station roof',
      stroll: 'Residents linger at their local destinations before returning home',
    },
  },
};

/** @param {unknown} result @returns {Decision} */
function extractDecision(result) {
  if (!record(result) || !record(result.answers)) throw new Error('Invalid evaluation response.');
  const { pace, stationActivity } = result.answers;
  if (
    !record(pace) ||
    pace.type !== 'choice' ||
    typeof pace.choice !== 'string' ||
    !PACES.includes(pace.choice)
  )
    throw new Error('Invalid pace choice.');
  if (
    !record(stationActivity) ||
    stationActivity.type !== 'choice' ||
    typeof stationActivity.choice !== 'string' ||
    !ACTIVITIES.includes(stationActivity.choice)
  )
    throw new Error('Invalid activity choice.');
  return /** @type {Decision} */ ({ pace: pace.choice, stationActivity: stationActivity.choice });
}

/**
 * One process-wide instance is shared by the HTTP server. Inject an evaluator
 * only for tests. Timed-out providers retain the inflight slot until settled.
 * @param {{evaluate?:Evaluator,hasCredentials?:()=>boolean,now?:()=>number,cooldownMs?:number,timeoutMs?:number}} [options]
 */
export function createDirector({
  evaluate = experimental_evaluate,
  hasCredentials = () => Boolean(process.env.AI_GATEWAY_API_KEY?.trim()),
  now = Date.now,
  cooldownMs = 15000,
  timeoutMs = 5000,
} = {}) {
  let inflight = false;
  let lastStarted = -Infinity;
  return {
    status() {
      const configured = hasCredentials();
      return {
        configured,
        source: configured ? 'jev' : 'fallback',
        model: MODEL,
        inflight,
        cooldownMs,
        retryAfterMs: Math.max(0, cooldownMs - (now() - lastStarted)),
      };
    },
    /** @param {unknown} raw @returns {Promise<DirectorResult>} */
    async decide(raw) {
      const input = validateInput(raw);
      if (!hasCredentials())
        return fallback(input, 'Local rules: AI Gateway credentials are not configured.');
      if (input.paused) return fallback(input, 'Local rules: the journey is paused.');
      if (inflight) return fallback(input, 'Local rules: a Jev evaluation is already running.');
      if (now() - lastStarted < cooldownMs)
        return fallback(input, 'Local rules: Jev is cooling down between evaluations.');
      inflight = true;
      lastStarted = now();
      const controller = new AbortController();
      let timedOut = false;
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let timer;
      const pending = Promise.resolve().then(() =>
        evaluate({
          model: MODEL,
          state: { ...input },
          questions,
          maxRetries: 0,
          abortSignal: controller.signal,
        }),
      );
      // Do not free the slot merely because the deadline raced the provider.
      void pending.then(
        () => {
          inflight = false;
        },
        () => {
          inflight = false;
        },
      );
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error('Evaluation deadline.'));
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([pending, deadline]);
        return {
          source: 'jev',
          reason: 'Jev selected these bounded sightseeing and station activity choices.',
          decision: extractDecision(result),
        };
      } catch {
        return fallback(
          input,
          timedOut
            ? 'Local rules: Jev exceeded its response deadline.'
            : 'Local rules: Jev was unavailable or returned an unsupported choice.',
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
