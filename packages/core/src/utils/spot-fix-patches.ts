export interface SpotFixPatch {
  readonly targetText: string;
  readonly replacementText: string;
}

export interface SpotFixPatchApplyResult {
  readonly applied: boolean;
  readonly revisedContent: string;
  readonly rejectedReason?: string;
  readonly appliedPatchCount: number;
  readonly touchedChars: number;
}

const MAX_SPOT_FIX_TOUCHED_RATIO = 0.25;

export function parseSpotFixPatches(raw: string): SpotFixPatch[] {
  const normalized = raw.includes("=== PATCHES ===")
    ? raw.slice(raw.indexOf("=== PATCHES ===") + "=== PATCHES ===".length)
    : raw;

  const patches: SpotFixPatch[] = [];
  const regex = /--- PATCH(?:\s+\d+)? ---\s*TARGET_TEXT:\s*([\s\S]*?)\s*REPLACEMENT_TEXT:\s*([\s\S]*?)\s*--- END PATCH ---/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalized)) !== null) {
    patches.push({
      targetText: trimField(match[1] ?? ""),
      replacementText: trimField(match[2] ?? ""),
    });
  }

  return patches.filter((patch) => patch.targetText.length > 0);
}

/**
 * 归一化引号，将弯引号转换为直引号以便匹配
 */
function normalizeQuotes(text: string): string {
  // 将中文弯引号转换为直引号
  return text
    .replace(/[""]/g, '"')  // 左双引号
    .replace(/[""]/g, '"')  // 右双引号
    .replace(/['']/g, "'")   // 左单引号
    .replace(/['']/g, "'");  // 右单引号
}

export function applySpotFixPatches(
  original: string,
  patches: ReadonlyArray<SpotFixPatch>,
): SpotFixPatchApplyResult {
  console.log(`[applySpotFixPatches] Starting with ${patches.length} patches, original length: ${original.length}`);

  if (patches.length === 0) {
    console.log(`[applySpotFixPatches] No patches to apply`);
    return {
      applied: false,
      revisedContent: original,
      rejectedReason: "No valid patches returned.",
      appliedPatchCount: 0,
      touchedChars: 0,
    };
  }

  const touchedChars = patches.reduce((sum, patch) => sum + patch.targetText.length, 0);
  console.log(`[applySpotFixPatches] Total touched chars: ${touchedChars}, ratio: ${original.length > 0 ? (touchedChars / original.length).toFixed(2) : 'N/A'}`);

  if (original.length > 0 && touchedChars / original.length > MAX_SPOT_FIX_TOUCHED_RATIO) {
    console.log(`[applySpotFixPatches] REJECTED: Patch set would touch too much of the chapter`);
    return {
      applied: false,
      revisedContent: original,
      rejectedReason: "Patch set would touch too much of the chapter.",
      appliedPatchCount: 0,
      touchedChars,
    };
  }

  let current = original;

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i];
    console.log(`[applySpotFixPatches] Applying patch ${i + 1}/${patches.length}:`);
    console.log(`  Target: "${patch.targetText.slice(0, 50)}${patch.targetText.length > 50 ? '...' : ''}"`);
    console.log(`  Replacement: "${patch.replacementText.slice(0, 50)}${patch.replacementText.length > 50 ? '...' : ''}"`);

    // 首先尝试精确匹配
    let start = current.indexOf(patch.targetText);
    
    // 如果精确匹配失败，尝试归一化引号后的匹配
    if (start === -1) {
      const normalizedTarget = normalizeQuotes(patch.targetText);
      const normalizedCurrent = normalizeQuotes(current);
      const normalizedStart = normalizedCurrent.indexOf(normalizedTarget);
      
      if (normalizedStart !== -1) {
        // 找到归一化后的匹配位置，映射回原始文本
        start = normalizedStart;
        console.log(`[applySpotFixPatches] Found match after normalizing quotes`);
      }
    }

    if (start === -1) {
      console.log(`[applySpotFixPatches] REJECTED: TARGET_TEXT not found in chapter`);
      console.log(`  Looking for: "${patch.targetText}"`);
      // 尝试找到相似的内容用于调试
      const contextStart = Math.max(0, current.indexOf(patch.targetText.slice(0, 20)));
      if (contextStart >= 0) {
        console.log(`  Similar content found at position ${contextStart}: "${current.slice(contextStart, contextStart + 100)}..."`);
      }
      return {
        applied: false,
        revisedContent: original,
        rejectedReason: "Each TARGET_TEXT must match the chapter exactly once.",
        appliedPatchCount: 0,
        touchedChars,
      };
    }

    // 检查是否有多个匹配（使用归一化后的文本检查）
    const normalizedTarget = normalizeQuotes(patch.targetText);
    const normalizedCurrent = normalizeQuotes(current);
    const normalizedStart = normalizedCurrent.indexOf(normalizedTarget);
    const anotherNormalized = normalizedCurrent.indexOf(normalizedTarget, normalizedStart + normalizedTarget.length);
    if (anotherNormalized !== -1) {
      console.log(`[applySpotFixPatches] REJECTED: TARGET_TEXT matches multiple times`);
      return {
        applied: false,
        revisedContent: original,
        rejectedReason: "Each TARGET_TEXT must match the chapter exactly once.",
        appliedPatchCount: 0,
        touchedChars,
      };
    }

    current = [
      current.slice(0, start),
      patch.replacementText,
      current.slice(start + patch.targetText.length),
    ].join("");
    console.log(`[applySpotFixPatches] Patch ${i + 1} applied successfully`);
  }

  console.log(`[applySpotFixPatches] All patches applied, revised content length: ${current.length}`);
  return {
    applied: current !== original,
    revisedContent: current,
    appliedPatchCount: patches.length,
    touchedChars,
  };
}

function trimField(value: string): string {
  return value.replace(/^\s*\n/, "").replace(/\n\s*$/, "").trim();
}
