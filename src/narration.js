import { createHash } from 'node:crypto';
import {
  VOICE_CAST,
  VOICE_DELIVERY,
  VOICE_MODEL,
  VOICE_REVISION,
  voiceSettings,
} from '@maple-line/voice-score';
import { DirectorError } from './director.js';
import { createNarrationCache, isNarrationWav } from './narration-cache.js';
export const NARRATION_LANGUAGES = [
  ['en-IN', 'English'],
  ['te-IN', 'Telugu'],
  ['hi-IN', 'Hindi'],
  ['ta-IN', 'Tamil'],
  ['bn-IN', 'Bengali'],
  ['mr-IN', 'Marathi'],
  ['gu-IN', 'Gujarati'],
  ['kn-IN', 'Kannada'],
  ['ml-IN', 'Malayalam'],
  ['pa-IN', 'Punjabi'],
  ['od-IN', 'Odia'],
].map(([code, label]) => ({ code, label }));

/** @typedef {{audio:Buffer,text:string,language:string}} Clip */
/** @typedef {{text:string,language:string,character:string,emotion:string}} Cue */
/** @typedef {{key:string,cue:Cue,priority:number,controller:AbortController,waiters:number,promise:Promise<Clip>,resolve:(clip:Clip)=>void,reject:(error:unknown)=>void}} Job */
const cancelled = () => new DirectorError(504, 'Narration was cancelled or timed out.');

/** @param {{apiKey?:string, fetchImpl?:typeof fetch, deadlineMs?:number, cacheDirectory?:string|null, concurrency?:number}} [options] */
export function createNarration({
  apiKey = process.env.SARVAM_API_KEY,
  fetchImpl = fetch,
  deadlineMs = 30000,
  cacheDirectory = null,
  concurrency = 2,
} = {}) {
  const disk = createNarrationCache(cacheDirectory);
  /** @type {Map<string, Clip>} */
  const cache = new Map();
  /** @type {Map<string, Job>} */
  const jobs = new Map();
  /** @type {Job[]} */
  const queue = [];
  let cacheBytes = 0,
    active = 0,
    hits = 0,
    generated = 0;
  const limit = Math.max(1, Math.min(4, concurrency));

  /** @param {string} key @param {Clip} clip */
  function remember(key, clip) {
    while (cache.size && (cache.size >= 128 || cacheBytes + clip.audio.length > 32000000)) {
      const oldest = /** @type {string} */ (cache.keys().next().value);
      cacheBytes -= /** @type {Clip} */ (cache.get(oldest)).audio.length;
      cache.delete(oldest);
    }
    cache.set(key, clip);
    cacheBytes += clip.audio.length;
    return clip;
  }
  /** @param {Job} job */
  async function generate(job) {
    const { cue, controller, key } = job;
    const stored = await disk.read(key);
    if (controller.signal.aborted) throw cancelled();
    if (stored) {
      hits++;
      return remember(key, { audio: stored, text: cue.text, language: cue.language });
    }
    if (!apiKey?.trim())
      throw new DirectorError(
        503,
        'Add SARVAM_API_KEY to the server .env and restart the director to enable narration.',
      );
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    /** @param {string} path @param {Record<string,unknown>} body */
    async function request(path, body) {
      const response = await fetchImpl(`https://api.sarvam.ai/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'api-subscription-key': /** @type {string} */ (apiKey),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new DirectorError(
          response.status === 429 ? 429 : 502,
          response.status === 429
            ? 'Sarvam is busy. Try narration again shortly.'
            : 'Sarvam could not prepare this narration. Check the server key and account access.',
        );
      return response.json();
    }
    try {
      let text = cue.text;
      if (cue.language !== 'en-IN') {
        const translated = await request('translate', {
          input: text,
          source_language_code: 'en-IN',
          target_language_code: cue.language,
          model: 'sarvam-translate:v1',
        });
        if (
          typeof translated.translated_text !== 'string' ||
          !translated.translated_text.trim() ||
          translated.translated_text.length > 2500
        )
          throw new DirectorError(502, 'Sarvam returned an unsupported translation.');
        text = translated.translated_text;
      }
      const result = await request('text-to-speech', {
        text,
        language_code: cue.language,
        model: VOICE_MODEL,
        ...voiceSettings(cue.character, cue.emotion),
        speech_sample_rate: 24000,
        output_audio_codec: 'wav',
      });
      if (
        !Array.isArray(result.audios) ||
        result.audios.length !== 1 ||
        typeof result.audios[0] !== 'string' ||
        result.audios[0].length > 16000000
      )
        throw new DirectorError(502, 'Sarvam returned an unsupported audio response.');
      const audio = Buffer.from(result.audios[0], 'base64');
      if (!isNarrationWav(audio))
        throw new DirectorError(502, 'Sarvam returned an unsupported audio format.');
      if (controller.signal.aborted) throw cancelled();
      await disk.write(key, audio);
      generated++;
      return remember(key, { audio, text: cue.text, language: cue.language });
    } catch (error) {
      if (controller.signal.aborted) throw cancelled();
      if (error instanceof DirectorError) throw error;
      throw new DirectorError(502, 'Sarvam narration is temporarily unavailable.');
    } finally {
      clearTimeout(timer);
    }
  }
  function pump() {
    queue.sort((a, b) => a.priority - b.priority);
    while (active < limit && queue.length) {
      const job = /** @type {Job} */ (queue.shift());
      if (job.controller.signal.aborted) {
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        job.reject(cancelled());
        continue;
      }
      active++;
      void generate(job)
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          if (jobs.get(job.key) === job) jobs.delete(job.key);
          pump();
        });
    }
  }
  /** @param {unknown} input @param {AbortSignal} [signal] */
  async function speak(input, signal) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new DirectorError(400, 'Invalid narration request.');
    const data = /** @type {Record<string,unknown>} */ (input);
    const character = data.character ?? 'narrator',
      emotion = data.emotion ?? 'natural';
    if (
      Object.keys(data).some(
        (key) => !['text', 'language', 'character', 'emotion', 'priority'].includes(key),
      ) ||
      typeof data.text !== 'string' ||
      !data.text.trim() ||
      data.text.length > 1600 ||
      !NARRATION_LANGUAGES.some((lang) => lang.code === data.language) ||
      typeof character !== 'string' ||
      !Object.hasOwn(VOICE_CAST, character) ||
      typeof emotion !== 'string' ||
      !Object.hasOwn(VOICE_DELIVERY, emotion) ||
      (data.priority !== undefined &&
        !['playback', 'prefetch'].includes(/** @type {string} */ (data.priority)))
    )
      throw new DirectorError(
        400,
        'Choose a supported language, character, delivery and 1–1600 characters of dialogue.',
      );
    if (signal?.aborted) throw cancelled();
    const cue = {
      text: data.text.trim(),
      language: /** @type {string} */ (data.language),
      character,
      emotion,
    };
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          VOICE_REVISION,
          VOICE_MODEL,
          'sarvam-translate:v1',
          cue,
          voiceSettings(character, emotion),
          24000,
        ]),
      )
      .digest('hex');
    const cached = cache.get(key);
    if (cached) {
      hits++;
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    let job = jobs.get(key);
    if (job?.controller.signal.aborted) job = undefined;
    const priority = data.priority === 'prefetch' ? 1 : 0;
    if (!job) {
      if (jobs.size >= 32)
        throw new DirectorError(429, 'The narration queue is full. Try again shortly.');
      let resolveJob = /** @type {(clip:Clip)=>void} */ (() => {});
      let rejectJob = /** @type {(error:unknown)=>void} */ (() => {});
      const promise = new Promise((resolve, reject) => {
        resolveJob = resolve;
        rejectJob = reject;
      });
      job = {
        key,
        cue,
        priority,
        controller: new AbortController(),
        waiters: 0,
        promise,
        resolve: resolveJob,
        reject: rejectJob,
      };
      jobs.set(key, job);
      queue.push(job);
    }
    job.priority = Math.min(job.priority, priority);
    const shared = job;
    shared.waiters++;
    queueMicrotask(pump);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        signal?.removeEventListener('abort', abort);
        shared.waiters--;
        return true;
      };
      const abort = () => {
        if (!finish()) return;
        if (!shared.waiters) shared.controller.abort();
        reject(cancelled());
      };
      signal?.addEventListener('abort', abort, { once: true });
      shared.promise.then(
        (value) => {
          if (finish()) resolve(value);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  }
  return {
    speak,
    status: () => ({
      configured: Boolean(apiKey?.trim()),
      provider: 'sarvam',
      model: VOICE_MODEL,
      defaultLanguage: 'en-IN',
      languages: NARRATION_LANGUAGES,
      busy: active > 0,
      active,
      queued: queue.length,
      cast: VOICE_CAST,
      delivery: VOICE_DELIVERY,
      revision: VOICE_REVISION,
      cache: { ...disk.status(), clips: cache.size, bytes: cacheBytes, hits, generated },
    }),
  };
}
