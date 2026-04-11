import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// 审计维度类型
export interface AuditDimension {
  id: string;
  name: string;
  enabled: boolean;
  weight: number;
  severity: "critical" | "warning" | "info";  // 问题严重程度
}

// 评分规则类型
export interface ScoringConfig {
  baseScore: number;
  penalties: {
    auditIssue: number;
    aiTellDensity: number;
    paragraphWarning: number;
  };
  weights: {
    auditPassRate: number;
    aiTellDensity: number;
    paragraphWarnings: number;
    hookResolveRate: number;
    duplicateTitles: number;
  };
}

// 验证规则类型
export interface ValidationRules {
  bannedPatterns: string[];
  bannedDashes: boolean;
  transitionWordDensity: number;
  fatigueWordLimit: number;
  maxConsecutiveLe: number;
  maxParagraphLength: number;
}

// 基础审核（大纲审核）配置类型
export interface FoundationReviewConfig {
  // 通过标准
  passThreshold: number;           // 总分通过阈值（默认80）
  dimensionFloor: number;          // 单个维度最低分（默认60）
  // 各维度权重（5个维度）
  weights: {
    coreConflict: number;          // 核心冲突
    openingMomentum: number;       // 开篇节奏
    worldCoherence: number;        // 世界一致性
    characterDifferentiation: number; // 角色区分度
    pacingFeasibility: number;     // 节奏可行性
  };
}

// 审计通过评判标准类型
export interface AuditPassCriteria {
  // 章节审计通过标准
  chapterAudit: {
    maxCriticalIssues: number;      // 最多允许的 critical 问题数
    maxWarningIssues: number;       // 最多允许的 warning 问题数
    maxTotalIssues: number;         // 最多允许的总问题数
  };
  // 分值计算规则
  scoringRules: {
    criticalIssueWeight: number;    // critical 问题扣分权重
    warningIssueWeight: number;     // warning 问题扣分权重
    infoIssueWeight: number;        // info 问题扣分权重
    minPassScore: number;           // 通过最低分数
  };
}

// 完整审计配置类型
export interface AuditConfig {
  dimensions: AuditDimension[];
  scoring: ScoringConfig;
  validationRules: ValidationRules;
  passCriteria: AuditPassCriteria;
  foundationReview: FoundationReviewConfig;
}

// 默认审计维度 - 按 severity 排序: critical > warning > info
const DEFAULT_DIMENSIONS: AuditDimension[] = [
  // Critical - 严重问题，直接影响内容质量
  { id: "ooc", name: "OOC检查", enabled: true, weight: 1.0, severity: "critical" },
  { id: "timeline", name: "时间线", enabled: true, weight: 1.0, severity: "critical" },
  { id: "settingConflict", name: "设定冲突", enabled: true, weight: 1.0, severity: "critical" },
  { id: "powerScaling", name: "战力崩坏", enabled: true, weight: 1.0, severity: "critical" },
  { id: "mainPlotConflict", name: "正传事件冲突", enabled: true, weight: 1.0, severity: "critical" },
  { id: "futureInfoLeak", name: "未来信息泄露", enabled: true, weight: 1.0, severity: "critical" },
  { id: "worldRuleConsistency", name: "世界规则跨书一致性", enabled: true, weight: 1.0, severity: "critical" },
  { id: "sideStoryForeshadowing", name: "番外伏笔隔离", enabled: true, weight: 1.0, severity: "critical" },
  { id: "infoLeak", name: "信息越界", enabled: true, weight: 1.0, severity: "critical" },
  { id: "knowledgeContamination", name: "知识库污染", enabled: true, weight: 1.0, severity: "critical" },
  { id: "perspectiveConsistency", name: "视角一致性", enabled: true, weight: 1.0, severity: "critical" },
  { id: "outlineDeviation", name: "大纲偏离检测", enabled: true, weight: 1.0, severity: "critical" },
  
  // Warning - 警告问题，影响阅读体验
  { id: "foreshadowing", name: "伏笔", enabled: true, weight: 1.0, severity: "warning" },
  { id: "pacing", name: "节奏", enabled: true, weight: 1.0, severity: "warning" },
  { id: "plotContinuity", name: "利益链断裂", enabled: true, weight: 1.0, severity: "warning" },
  { id: "sideCharacterDumbing", name: "配角降智", enabled: true, weight: 1.0, severity: "warning" },
  { id: "sideCharacterToolization", name: "配角工具人化", enabled: true, weight: 1.0, severity: "warning" },
  { id: "satisfaction", name: "爽点虚化", enabled: true, weight: 1.0, severity: "warning" },
  { id: "dialogueAuthenticity", name: "台词失真", enabled: true, weight: 1.0, severity: "warning" },
  { id: "流水账", name: "流水账", enabled: true, weight: 1.0, severity: "warning" },
  { id: "formulaicTwists", name: "公式化转折", enabled: true, weight: 1.0, severity: "warning" },
  { id: "listStructure", name: "列表式结构", enabled: true, weight: 1.0, severity: "warning" },
  { id: "subplotStagnation", name: "支线停滞", enabled: true, weight: 1.0, severity: "warning" },
  { id: "emotionalFlatness", name: "弧线平坦", enabled: true, weight: 1.0, severity: "warning" },
  { id: "pacingMonotony", name: "节奏单调", enabled: true, weight: 1.0, severity: "warning" },
  { id: "readerExpectation", name: "读者期待管理", enabled: true, weight: 1.0, severity: "warning" },
  { id: "numericalCheck", name: "数值检查", enabled: true, weight: 1.0, severity: "warning" },
  
  // Info - 提示问题，轻微影响
  { id: "writingStyle", name: "文风", enabled: true, weight: 1.0, severity: "info" },
  { id: "vocabularyFatigue", name: "词汇疲劳", enabled: true, weight: 1.0, severity: "info" },
  { id: "historicalAccuracy", name: "年代考据", enabled: true, weight: 1.0, severity: "info" },
  { id: "paragraphLength", name: "段落等长", enabled: true, weight: 1.0, severity: "info" },
  { id: "clicheDensity", name: "套话密度", enabled: true, weight: 1.0, severity: "info" },
  { id: "sensitiveContent", name: "敏感词检查", enabled: true, weight: 1.0, severity: "info" },
];

// 默认评分规则
const DEFAULT_SCORING: ScoringConfig = {
  baseScore: 100,
  penalties: {
    auditIssue: 5,
    aiTellDensity: 20,
    paragraphWarning: 3,
  },
  weights: {
    auditPassRate: 0.3,
    aiTellDensity: 0.25,
    paragraphWarnings: 0.15,
    hookResolveRate: 0.2,
    duplicateTitles: 0.1,
  },
};

// 默认验证规则
const DEFAULT_VALIDATION_RULES: ValidationRules = {
  bannedPatterns: ["不是……而是……"],
  bannedDashes: true,
  transitionWordDensity: 1,
  fatigueWordLimit: 1,
  maxConsecutiveLe: 6,
  maxParagraphLength: 300,
};

// 默认审计通过评判标准
const DEFAULT_PASS_CRITERIA: AuditPassCriteria = {
  chapterAudit: {
    maxCriticalIssues: 0,      // 默认不允许 critical 问题
    maxWarningIssues: 5,       // 最多 5 个 warning
    maxTotalIssues: 10,        // 最多 10 个问题
  },
  scoringRules: {
    criticalIssueWeight: 3.0,  // critical 问题扣 3 倍权重分
    warningIssueWeight: 1.0,   // warning 问题扣 1 倍权重分
    infoIssueWeight: 0.5,      // info 问题扣 0.5 倍权重分
    minPassScore: 60,          // 最低通过分数 60
  },
};

// 默认基础审核配置
const DEFAULT_FOUNDATION_REVIEW: FoundationReviewConfig = {
  passThreshold: 80,           // 总分通过阈值
  dimensionFloor: 60,          // 单个维度最低分
  weights: {
    coreConflict: 1.0,         // 核心冲突
    openingMomentum: 1.0,      // 开篇节奏
    worldCoherence: 1.0,       // 世界一致性
    characterDifferentiation: 1.0, // 角色区分度
    pacingFeasibility: 1.0,    // 节奏可行性
  },
};

// 默认配置
const DEFAULT_CONFIG: AuditConfig = {
  dimensions: DEFAULT_DIMENSIONS,
  scoring: DEFAULT_SCORING,
  validationRules: DEFAULT_VALIDATION_RULES,
  passCriteria: DEFAULT_PASS_CRITERIA,
  foundationReview: DEFAULT_FOUNDATION_REVIEW,
};

// 全局配置路径
const GLOBAL_CONFIG_PATH = join(homedir(), ".inkos", "audit-config.json");

/**
 * 加载审计配置
 * @param bookDir 书籍目录路径（可选，用于加载项目级配置）
 * @returns 合并后的审计配置
 */
export function loadAuditConfig(bookDir?: string): AuditConfig {
  // 加载全局配置
  let globalConfig: AuditConfig | null = null;
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      const content = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
      globalConfig = JSON.parse(content) as AuditConfig;
    } catch (error) {
      console.warn("Failed to load global audit config, using defaults:", error);
    }
  }

  // 加载项目级配置
  let projectConfig: AuditConfig | null = null;
  if (bookDir) {
    const projectConfigPath = join(bookDir, "audit-config.json");
    if (existsSync(projectConfigPath)) {
      try {
        const content = readFileSync(projectConfigPath, "utf-8");
        projectConfig = JSON.parse(content) as AuditConfig;
      } catch (error) {
        console.warn("Failed to load project audit config, using global or defaults:", error);
      }
    }
  }

  // 合并配置（项目 > 全局 > 默认）
  return mergeConfigs(
    DEFAULT_CONFIG,
    globalConfig || DEFAULT_CONFIG,
    projectConfig || globalConfig || DEFAULT_CONFIG
  );
}

/**
 * 合并配置
 * @param defaults 默认配置
 * @param global 全局配置
 * @param project 项目配置
 * @returns 合并后的配置
 */
function mergeConfigs(defaults: AuditConfig, global: AuditConfig, project: AuditConfig): AuditConfig {
  // 合并维度
  const dimensions = defaults.dimensions.map(defaultDim => {
    const globalDim = global.dimensions.find(d => d.id === defaultDim.id);
    const projectDim = project.dimensions.find(d => d.id === defaultDim.id);
    
    return {
      ...defaultDim,
      ...(globalDim || {}),
      ...(projectDim || {}),
    };
  });

  // 合并评分规则
  const scoring: ScoringConfig = {
    ...defaults.scoring,
    ...global.scoring,
    ...project.scoring,
    penalties: {
      ...defaults.scoring.penalties,
      ...(global.scoring?.penalties || {}),
      ...(project.scoring?.penalties || {}),
    },
    weights: {
      ...defaults.scoring.weights,
      ...(global.scoring?.weights || {}),
      ...(project.scoring?.weights || {}),
    },
  };

  // 合并验证规则
  const validationRules: ValidationRules = {
    ...defaults.validationRules,
    ...global.validationRules,
    ...project.validationRules,
  };

  // 合并评判标准
  const passCriteria: AuditPassCriteria = {
    chapterAudit: {
      ...defaults.passCriteria.chapterAudit,
      ...(global.passCriteria?.chapterAudit || {}),
      ...(project.passCriteria?.chapterAudit || {}),
    },
    scoringRules: {
      ...defaults.passCriteria.scoringRules,
      ...(global.passCriteria?.scoringRules || {}),
      ...(project.passCriteria?.scoringRules || {}),
    },
  };

  // 合并基础审核配置
  const foundationReview: FoundationReviewConfig = {
    ...defaults.foundationReview,
    ...global.foundationReview,
    ...project.foundationReview,
    weights: {
      ...defaults.foundationReview.weights,
      ...(global.foundationReview?.weights || {}),
      ...(project.foundationReview?.weights || {}),
    },
  };

  return {
    dimensions,
    scoring,
    validationRules,
    passCriteria,
    foundationReview,
  };
}

/**
 * 保存全局审计配置
 * @param config 审计配置
 */
export function saveGlobalAuditConfig(config: AuditConfig): void {
  // 确保目录存在
  const configDir = join(homedir(), ".inkos");
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * 保存项目级审计配置
 * @param bookDir 书籍目录路径
 * @param config 审计配置
 */
export function saveProjectAuditConfig(bookDir: string, config: AuditConfig): void {
  const projectConfigPath = join(bookDir, "audit-config.json");
  writeFileSync(projectConfigPath, JSON.stringify(config, null, 2));
}

/**
 * 获取默认审计配置
 * @returns 默认审计配置
 */
export function getDefaultAuditConfig(): AuditConfig {
  return { ...DEFAULT_CONFIG };
}
