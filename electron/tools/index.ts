// ============================================================================
// vellum - tools/index.ts (F6)
// ============================================================================
// az osszes eszkoz regisztralasa egy helyen.
//
// ezt a fuggvenyt kell meghivni az app indulasakor, a main.ts-bol.
//
// FONTOS: a sorrend nem szamit a regisztraciokor, mert a valasztas
// prioritas alapjan tortenik (lasd registry.ts selectTools).
// ============================================================================

import { registerTool, clearRegistry } from './registry';
import { calculateTool } from './calc';
import { dateTimeTool } from './datetime';
import { readFileTool, listDirectoryTool } from './files';
import { searchMemoryTool, saveMemoryTool } from './memoryTools';
import { readArtifactTool, listArtifactsTool } from './artifactTools';
import { loadSkillTool, listSkillsTool } from './skillTools';
import { webSearchTool } from './websearch';

export * from './registry';
export * from './guard';

/**
 * regisztralja az osszes beepitett eszkozt.
 *
 * az mcp eszkozok kulon jonnek, az mcp/bridge.ts-bol -- azok
 * futasidoben derulnek ki, es retrieval alapjan valogatunk kozuluk.
 */
export function registerBuiltinTools(): void {
  clearRegistry();

  // compute
  registerTool(calculateTool);

  // time
  registerTool(dateTimeTool);

  // search
  registerTool(webSearchTool);

  // memory
  registerTool(searchMemoryTool);
  registerTool(saveMemoryTool);

  // files
  registerTool(readFileTool);
  registerTool(listDirectoryTool);

  // artifacts
  registerTool(readArtifactTool);
  registerTool(listArtifactsTool);

  // skills
  registerTool(loadSkillTool);
  registerTool(listSkillsTool);
}

/**
 * a beepitett eszkozok listaja, dokumentacios celra.
 *
 * ez a tablazat mutatja, hogy a 8-as korlat mellett melyik eszkozok
 * versenyeznek egymassal. a prioritas donti el, ki marad bent.
 */
export const BUILTIN_TOOL_SUMMARY = [
  { name: 'web_search', category: 'search', priority: 100 },
  { name: 'get_datetime', category: 'time', priority: 95 },
  { name: 'calculate', category: 'compute', priority: 90 },
  { name: 'search_memory', category: 'memory', priority: 85 },
  { name: 'load_skill', category: 'skills', priority: 80 },
  { name: 'read_artifact', category: 'artifacts', priority: 75 },
  { name: 'read_file', category: 'files', priority: 70 },
  { name: 'list_directory', category: 'files', priority: 65 },
  { name: 'save_memory', category: 'memory', priority: 60 },
  { name: 'list_artifacts', category: 'artifacts', priority: 40 },
  { name: 'list_skills', category: 'skills', priority: 35 },
] as const;
