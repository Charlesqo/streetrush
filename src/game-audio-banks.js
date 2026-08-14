export const MX5_CANDIDATE_BANK_ID = 'bank.candidate.i4.mazda-b6-compatibility-proxy';

export const GAME_AUDIO_BANK_IDS = Object.freeze({
  mx5: MX5_CANDIDATE_BANK_ID,
  m3e30: 'bank.candidate.i4.bmw-s14b23',
  gt3rs: 'bank.candidate.flat6.porsche-gt3-992-dacxl',
  lp700: 'bank.candidate.v12.lamborghini-l539-dacxl',
  amggt3: 'bank.candidate.v8-mercedes-m159-compression-compatible-proxy',
  m5g90: 'bank.candidate.v8-bmw-s68-compression-compatible-proxy',
});

export const GAME_AUDIO_BANKS = Object.freeze({
  banks: Object.freeze([
    ['mx5', 'i4', 'candidate-2026-08-13-i4-mazda-b6-compatibility-proxy'],
    ['m3e30', 'i4', 'candidate-2026-08-10-i4-bmw-s14b23'],
    ['gt3rs', 'flat6', 'candidate-2026-08-13-flat6-porsche-gt3-rs-992-spec'],
    ['lp700', 'v12', 'candidate-2026-08-13-v12-lamborghini-l539-lp700-spec-coverage'],
    ['amggt3', 'v8', 'candidate-2026-08-13-v8-mercedes-m159-compression-compatible-proxy-m159-reference'],
    ['m5g90', 'v8', 'candidate-2026-08-13-v8-bmw-s68-compression-compatible-proxy-s68-compression-reference'],
  ].map(([vehicleId, family, assetVersion]) => Object.freeze({
    id: GAME_AUDIO_BANK_IDS[vehicleId],
    scope: 'family',
    family,
    quality: 'candidate-loop-approved',
    assetVersion,
    rootUrl: `/audio-banks/${vehicleId}`,
    manifestFile: 'bank.json',
  }))),
});

export function createGameAudioProfile(config) {
  if (!config?.id || !config?.audio?.family) {
    throw new TypeError('Game audio profile requires a vehicle config');
  }
  return {
    id: config.id,
    displayName: config.name ?? config.id,
    engine: {
      family: config.audio.family,
      cylinders: { value: config.audio.cylinders },
      idleRpm: { value: config.idle },
      redlineRpm: { value: config.redline },
    },
    audio: {
      familyFallbackBankIds: GAME_AUDIO_BANK_IDS[config.id]
        ? [GAME_AUDIO_BANK_IDS[config.id]]
        : [],
      proceduralFallback: true,
    },
  };
}
