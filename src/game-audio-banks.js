export const MX5_CANDIDATE_BANK_ID = 'bank.candidate.i4.mazda-b6-compatibility-proxy';

export const GAME_AUDIO_BANKS = Object.freeze({
  banks: Object.freeze([Object.freeze({
    id: MX5_CANDIDATE_BANK_ID,
    scope: 'family',
    family: 'i4',
    quality: 'candidate-loop-approved',
    assetVersion: 'candidate-2026-08-13-i4-mazda-b6-compatibility-proxy',
    rootUrl: '/audio-banks/mx5',
    manifestFile: 'bank.json',
  })]),
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
      familyFallbackBankIds: config.id === 'mx5' ? [MX5_CANDIDATE_BANK_ID] : [],
      proceduralFallback: true,
    },
  };
}
