const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("fs");
const { join, homedir } = require("path");

// 审计维度类型
function AuditDimension() {}
AuditDimension.prototype = {
  id: "",
  name: "",
  enabled: true,
  weight: 1.0
};

// 评分规则类型
function ScoringConfig() {}
ScoringConfig.prototype = {
  baseScore: 100,
  penalties: {
    auditIssue: 5,
    aiTellDensity: 20,
    paragraphWarning: 3
  },
  weights: {
    auditPassRate: 0.3,
    aiTellDensity: 0.25,
    paragraphWarnings: 0.15,
    hookResolveRate: 0.2,
    duplicateTitles: 0.1
  }
};

// 验证规则类型
function ValidationRules() {}
ValidationRules.prototype = {
  bannedPatterns: [],
  bannedDashes: true,
  transitionWordDensity: 1,
  fatigueWordLimit: 1,
  maxConsecutiveLe: 6,
  maxParagraphLength: 300
};

// 完整审计配置类型
function AuditConfig() {}
AuditConfig.prototype = {
  dimensions: [],
  scoring: new ScoringConfig(),
  validationRules: new ValidationRules()
};

// 默认审计维度
const DEFAULT_DIMENSIONS = [
  { id: "ooc", name: "OOC检查", enabled: true, weight: 1.0 },
  { id: "timeline", name: "时间线", enabled: true, weight: 1.0 },
  { id: "settingConflict", name: "设定冲突", enabled: true, weight: 1.0 },
  { id: "powerScaling", name: "战力崩坏", enabled: true, weight: 1.0 },
  { id: "numericalCheck", name: "数值检查", enabled: true, weight: 1.0 },
  { id: "foreshadowing", name: "伏笔", enabled: true, weight: 1.0 },
  { id: "pacing", name: "节奏", enabled: true, weight: 1.0 },
  { id: "writingStyle", name: "文风", enabled: true, weight: 1.0 },
  { id: "infoLeak", name: "信息越界", enabled: true, weight: 1.0 },
  { id: "vocabularyFatigue", name: "词汇疲劳", enabled: true, weight: 1.0 },
  { id: "plotContinuity", name: "利益链断裂", enabled: true, weight: 1.0 },
  { id: "historicalAccuracy", name: "年代考据", enabled: true, weight: 1.0 },
  { id: "sideCharacterDumbing", name: "配角降智", enabled: true, weight: 1.0 },
  { id: "sideCharacterToolization", name: "配角工具人化", enabled: true, weight: 1.0 },
  { id: "satisfaction", name: "爽点虚化", enabled: true, weight: 1.0 },
  { id: "dialogueAuthenticity", name: "台词失真", enabled: true, weight: 1.0 },
  { id: "流水账", name: "流水账", enabled: true, weight: 1.0 },
  { id: "knowledgeContamination", name: "知识库污染", enabled: true, weight: 1.0 },
  { id: "perspectiveConsistency", name: "视角一致性", enabled: true, weight: 1.0 },
  { id: "paragraphLength", name: "段落等长", enabled: true, weight: 1.0 },
  { id: "clicheDensity", name: "套话密度", enabled: true, weight: 1.0 },
  { id: "formulaicTwists", name: "公式化转折", enabled: true, weight: 1.0 },
  { id: "listStructure", name: "列表式结构", enabled: true, weight: 1.0 },
  { id: "subplotStagnation", name: "支线停滞", enabled: true, weight: 1.0 },
  { id: "emotionalFlatness", name: "弧线平坦", enabled: true, weight: 1.0 },
  { id: "pacingMonotony", name: "节奏单调", enabled: true, weight: 1.0 },
  { id: "sensitiveContent", name: "敏感词检查", enabled: true, weight: 1.0 },
  { id: "mainPlotConflict", name: "正传事件冲突", enabled: true, weight: 1.0 },
  { id: "futureInfoLeak", name: "未来信息泄露", enabled: true, weight: 1.0 },
  { id: "worldRuleConsistency", name: "世界规则跨书一致性", enabled: true, weight: 1.0 },
  { id: "sideStoryForeshadowing", name: "番外伏笔隔离", enabled: true, weight: 1.0 },
  { id: "readerExpectation", name: "读者期待管理", enabled: true, weight: 1.0 },
  { id: "outlineDeviation", name: "大纲偏离检测", enabled: true, weight: 1.0 },
];

// 默认评分规则
const DEFAULT_SCORING = {
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
const DEFAULT_VALIDATION_RULES = {
  bannedPatterns: ["不是……而是……"],
  bannedDashes: true,
  transitionWordDensity: 1,
  fatigueWordLimit: 1,
  maxConsecutiveLe: 6,
  maxParagraphLength: 300,
};

// 默认配置
const DEFAULT_CONFIG = {
  dimensions: DEFAULT_DIMENSIONS,
  scoring: DEFAULT_SCORING,
  validationRules: DEFAULT_VALIDATION_RULES,
};

// 全局配置路径
const GLOBAL_CONFIG_PATH = join(homedir(), ".inkos", "audit-config.json");

/**
 * 加载审计配置
 * @param bookDir 书籍目录路径（可选，用于加载项目级配置）
 * @returns 合并后的审计配置
 */
function loadAuditConfig(bookDir) {
  // 加载全局配置
  let globalConfig = null;
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      const content = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
      globalConfig = JSON.parse(content);
    } catch (error) {
      console.warn("Failed to load global audit config, using defaults:", error);
    }
  }

  // 加载项目级配置
  let projectConfig = null;
  if (bookDir) {
    const projectConfigPath = join(bookDir, "audit-config.json");
    if (existsSync(projectConfigPath)) {
      try {
        const content = readFileSync(projectConfigPath, "utf-8");
        projectConfig = JSON.parse(content);
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
function mergeConfigs(defaults, global, project) {
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
  const scoring = {
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
  const validationRules = {
    ...defaults.validationRules,
    ...global.validationRules,
    ...project.validationRules,
  };

  return {
    dimensions,
    scoring,
    validationRules,
  };
}

/**
 * 保存全局审计配置
 * @param config 审计配置
 */
function saveGlobalAuditConfig(config) {
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
function saveProjectAuditConfig(bookDir, config) {
  const projectConfigPath = join(bookDir, "audit-config.json");
  writeFileSync(projectConfigPath, JSON.stringify(config, null, 2));
}

/**
 * 获取默认审计配置
 * @returns 默认审计配置
 */
function getDefaultAuditConfig() {
  return { ...DEFAULT_CONFIG };
}

// 导出模块
module.exports = {
  loadAuditConfig,
  saveGlobalAuditConfig,
  saveProjectAuditConfig,
  getDefaultAuditConfig
};
