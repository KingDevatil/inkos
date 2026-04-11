export interface VolumeOutline {
  volumeId: number;
  title: string;
  chapterRange: {
    start: number;
    end: number;
  };
  coreConflict?: string;
  keyTurningPoints?: string;
  payoffGoals?: string;
  outline: string;
}

interface VolumeBoundary {
  volumeId: number;
  title: string;
  chapterStart?: number;
  chapterEnd?: number;
  startIndex: number;
  endIndex: number;
}

export function parseVolumeOutline(content: string): VolumeOutline[] {
  const volumes: VolumeOutline[] = [];
  
  const volumeBoundaries = detectVolumeBoundaries(content);
  
  if (volumeBoundaries.length === 0) {
    return extractVolumesFromTable(content);
  }
  
  for (let i = 0; i < volumeBoundaries.length; i++) {
    const boundary = volumeBoundaries[i];
    const nextBoundary = volumeBoundaries[i + 1];
    const volumeContent = content.substring(
      boundary.startIndex,
      nextBoundary ? nextBoundary.startIndex : content.length
    ).trim();
    
    const volume = parseSingleVolume(volumeContent, boundary);
    if (volume) {
      volumes.push(volume);
    }
  }
  
  return volumes;
}

function detectVolumeBoundaries(content: string): VolumeBoundary[] {
  const boundaries: VolumeBoundary[] = [];
  const lines = content.split('\n');
  
  const patterns = [
    /^#{2,4}\s*第.*?卷 [：:]([^(]+)\((\d+)-(\d+) 章\)/,
    /^#{2,4}\s*第.*?卷 [：:]([^(]+)（(\d+)-(\d+) 章）/,
    /^#{2,4}\s*第.*?卷 [：:]([^(]+)$/,
    /^#{2,4}\s*卷 ([一二三四五六七八九十\d]+)[：:]\s*(.+?)$/,
    /^#{2,4}\s*Volume\s+(\d+)[：:]\s*(.+?)$/i
  ];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        let volumeId: number;
        let title: string;
        let chapterStart: number | undefined;
        let chapterEnd: number | undefined;
        
        if (pattern.source.includes('Volume')) {
          volumeId = parseInt(match[1], 10);
          title = match[2]?.trim() || '';
        } else if (pattern.source.includes('卷 ([一二三四五六七八九十\\d]+)')) {
          volumeId = parseVolumeNumber(match[1]);
          title = match[2]?.trim() || '';
        } else {
          const titlePart = match[1]?.trim() || '';
          const titleMatch = titlePart.match(/([一二三四五六七八九十\d]+)[·.:\s:](.+)/);
          if (titleMatch) {
            volumeId = parseVolumeNumber(titleMatch[1]);
            title = titleMatch[2]?.trim() || titlePart;
          } else {
            volumeId = boundaries.length + 1;
            title = titlePart;
          }
          if (match[2] && /^\d+$/.test(match[2])) {
            chapterStart = parseInt(match[2], 10);
            chapterEnd = parseInt(match[3] || '0', 10);
          }
        }
        
        boundaries.push({
          volumeId,
          title,
          chapterStart,
          chapterEnd,
          startIndex: content.split('\n').slice(0, i).join('\n').length + (i > 0 ? i : 0),
          endIndex: 0
        });
        break;
      }
    }
  }
  
  for (let i = 0; i < boundaries.length; i++) {
    if (i < boundaries.length - 1) {
      boundaries[i]!.endIndex = boundaries[i + 1]!.startIndex;
    } else {
      boundaries[i]!.endIndex = content.length;
    }
  }
  
  return boundaries;
}

function parseSingleVolume(content: string, boundary: VolumeBoundary): VolumeOutline | null {
  let chapterStart = boundary.chapterStart;
  let chapterEnd = boundary.chapterEnd;
  
  if (chapterStart === undefined || chapterEnd === undefined) {
    const rangeInfo = extractChapterRange(content);
    if (chapterStart === undefined) chapterStart = rangeInfo.start;
    if (chapterEnd === undefined) chapterEnd = rangeInfo.end;
  }
  
  const coreConflict = extractField(content, [
    '核心冲突', 'Core Conflict', '冲突', 'Conflict'
  ]);
  
  const keyTurningPoints = extractField(content, [
    '关键转折', 'Key Turning Points', '转折点', 'Turning Points', '关键事件'
  ]);
  
  const payoffGoals = extractField(content, [
    '收益目标', 'Payoff Goal', '目标', 'Goals', '收益', '收获'
  ]);
  
  return {
    volumeId: boundary.volumeId,
    title: boundary.title,
    chapterRange: {
      start: chapterStart || 0,
      end: chapterEnd || 0
    },
    coreConflict,
    keyTurningPoints,
    payoffGoals,
    outline: content
  };
}

function extractChapterRange(content: string): { start?: number; end?: number } {
  const rangePattern = /\*\*章节范围\*\*[：:]\s*(\d+)[-–](\d+)/i;
  const match = content.match(rangePattern);
  if (match) {
    return {
      start: parseInt(match[1], 10),
      end: parseInt(match[2], 10)
    };
  }
  
  const tablePattern = /(\d+)[-–](\d+) 章/;
  const tableMatch = content.match(tablePattern);
  if (tableMatch) {
    return {
      start: parseInt(tableMatch[1], 10),
      end: parseInt(tableMatch[2], 10)
    };
  }
  
  return {};
}

function extractField(content: string, fieldNames: string[]): string {
  for (const fieldName of fieldNames) {
    const boldPattern = new RegExp(
      `\\*\\*${fieldName}\\*\\*[：:]\\s*([\\s\\S]*?)(?=\\n\\*\\*|\\n---|$)`,
      'i'
    );
    const boldMatch = content.match(boldPattern);
    if (boldMatch && boldMatch[1]) {
      return boldMatch[1].trim();
    }
    
    const normalPattern = new RegExp(
      `${fieldName}[：:]\\s*([\\s\\S]*?)(?=\\n\\w|$)`,
      'i'
    );
    const normalMatch = content.match(normalPattern);
    if (normalMatch && normalMatch[1]) {
      return normalMatch[1].trim();
    }
  }
  
  return '';
}

function parseVolumeNumber(numStr: string): number {
  const chineseNumbers = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  
  if (/^\d+$/.test(numStr)) {
    return parseInt(numStr, 10);
  }
  
  let result = 0;
  for (const char of numStr) {
    const index = chineseNumbers.indexOf(char);
    if (index > 0) {
      result = result * 10 + index;
    }
  }
  return result || 1;
}

function extractVolumesFromTable(content: string): VolumeOutline[] {
  const tableRegex = /\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|/g;
  const volumes: VolumeOutline[] = [];
  let match;
  let volumeId = 1;
  
  while ((match = tableRegex.exec(content)) !== null) {
    const cells = match.slice(1).map(c => c.trim());
    if (cells[0]?.includes('卷名') || cells[0]?.includes('Volume')) {
      continue;
    }
    
    const chapterRange = extractChapterRangeFromCell(cells[1] || '');
    
    volumes.push({
      volumeId: volumeId++,
      title: cells[0] || `第${volumeId}卷`,
      chapterRange: {
        start: chapterRange.start || 0,
        end: chapterRange.end || 0
      },
      coreConflict: cells[2] || '',
      keyTurningPoints: cells[3] || '',
      payoffGoals: cells[4] || '',
      outline: `### ${cells[0] || `第${volumeId}卷`}\n\n**核心冲突**：${cells[2] || ''}`
    });
  }
  
  return volumes;
}

function extractChapterRangeFromCell(cell: string): { start: number; end: number } {
  const match = cell.match(/(\d+)[-–](\d+)/);
  if (match) {
    return {
      start: parseInt(match[1], 10),
      end: parseInt(match[2], 10)
    };
  }
  return { start: 0, end: 0 };
}
