import type {
  SttProviderBundle,
  TtsProviderBundle,
  VoiceProviderId,
} from './contracts.js';

export interface VoiceProviderRegistration {
  createStt?: () => SttProviderBundle;
  createTts?: () => TtsProviderBundle;
}

export type VoiceProviderRegistry = Partial<Record<VoiceProviderId, VoiceProviderRegistration>>;

export interface SelectedVoiceProviders {
  sttProvider: VoiceProviderId;
  ttsProvider: VoiceProviderId;
  stt: SttProviderBundle;
  tts: TtsProviderBundle;
}

function requireRegistration(
  provider: VoiceProviderId,
  capability: 'STT' | 'TTS',
  registry: VoiceProviderRegistry,
): VoiceProviderRegistration {
  const registration = registry[provider];
  if (!registration) {
    throw new Error(`${capability} provider ${provider} is not registered`);
  }
  return registration;
}

export function createSelectedVoiceProviders(
  selection: { sttProvider: VoiceProviderId; ttsProvider: VoiceProviderId },
  registry: VoiceProviderRegistry,
): SelectedVoiceProviders {
  const sttRegistration = requireRegistration(selection.sttProvider, 'STT', registry);
  const ttsRegistration = requireRegistration(selection.ttsProvider, 'TTS', registry);
  if (!sttRegistration.createStt) {
    throw new Error(`STT provider ${selection.sttProvider} does not implement STT`);
  }
  if (!ttsRegistration.createTts) {
    throw new Error(`TTS provider ${selection.ttsProvider} does not implement TTS`);
  }

  return {
    sttProvider: selection.sttProvider,
    ttsProvider: selection.ttsProvider,
    stt: sttRegistration.createStt(),
    tts: ttsRegistration.createTts(),
  };
}
