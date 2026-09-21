/** Increment when casting or delivery changes to invalidate prepared audio. */
export const VOICE_REVISION = 'cast-2';
export const VOICE_MODEL = 'bulbul:v3';
/** Stable casting; emotion never changes a character's identity. */
export const VOICE_CAST = {
  narrator: { name: 'Narrator', speaker: 'shubh', pace: 0.95 },
  haru: { name: 'Haru', speaker: 'ratan', pace: 0.91 },
  emi: { name: 'Emi', speaker: 'ritu', pace: 1.04 },
  nao: { name: 'Nao', speaker: 'priya', pace: 1.02 },
  fumi: { name: 'Fumi', speaker: 'roopa', pace: 0.97 },
  jun: { name: 'Jun', speaker: 'aditya', pace: 0.98 },
  yuta: { name: 'Yuta', speaker: 'rohan', pace: 1.0 },
  mika: { name: 'Mika', speaker: 'kavya', pace: 1.03 },
  keiko: { name: 'Keiko', speaker: 'kavitha', pace: 0.96 },
  son: { name: 'Haru’s son', speaker: 'rahul', pace: 1.0 },
};
/** Direction is expressed through pace and timed silence, not unsupported emotion tags. */
export const VOICE_DELIVERY = {
  natural: { pace: 1, pauseMs: 320 },
  warm: { pace: 0.96, pauseMs: 420 },
  playful: { pace: 1.06, pauseMs: 240 },
  curious: { pace: 1.02, pauseMs: 380 },
  reflective: { pace: 0.91, pauseMs: 650 },
  vulnerable: { pace: 0.88, pauseMs: 850 },
  reassuring: { pace: 0.93, pauseMs: 550 },
  excited: { pace: 1.1, pauseMs: 220 },
};
/** @param {string} character @param {string} emotion */
export function voiceSettings(character, emotion) {
  const cast = VOICE_CAST[/** @type {keyof typeof VOICE_CAST} */ (character)];
  const delivery = VOICE_DELIVERY[/** @type {keyof typeof VOICE_DELIVERY} */ (emotion)];
  return { speaker: cast.speaker, pace: Math.round(cast.pace * delivery.pace * 100) / 100 };
}
