import type { AiProvider } from './AiProvider';
import type { AppSettings } from '../types/settings';
import { OllamaProvider } from './OllamaProvider';

const ollama = new OllamaProvider();

/** A beallitasokbol mindig a friss ertekekkel konfiguralt OllamaProvider-t adja vissza. */
export function getProvider(settings: AppSettings): AiProvider {
  ollama.configure({
    host: settings.ollamaHost,
    model: settings.ollamaModel,
    webSearchEnabled: settings.webSearchEnabled,
    darkPersona: settings.darkPersona,
    contextSize: settings.ollamaContextSize,
    idleTimeoutSec: settings.ollamaIdleTimeoutSec,
    routerEnabled: settings.routerEnabled,
    skillsEnabled: settings.skillsEnabled,
    maxSkillsPerTurn: settings.maxSkillsPerTurn
  });
  return ollama;
}
