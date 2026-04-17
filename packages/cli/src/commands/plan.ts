import { Command } from "commander";
import { PipelineRunner } from "@actalk/inkos-core";
import { loadConfig, buildPipelineConfig, findProjectRoot } from "../utils.js";

export const planCommand = new Command("plan")
  .description("大纲管理相关命令");

planCommand
  .command("regenerate")
  .description("重新生成剧情规划（保留设定，重写卷纲/状态/待填坑）")
  .argument("<bookId>", "书籍ID")
  .option("-i, --instruction <text>", "额外的生成指导，如：优化节奏、增加反转等")
  .action(async (bookId, options) => {
    try {
      const root = findProjectRoot();
      const config = await loadConfig();
      const runner = new PipelineRunner(buildPipelineConfig(config, root));

      console.log(`\n即将重新生成 "${bookId}" 的剧情规划...`);
      console.log("├─ 保留：story_bible.md、characters/、book_rules.md");
      console.log("├─ 重写：volume_outline.md、current_state.md、pending_hooks.md");
      console.log("├─ 更新：.volume-plans-meta.json");
      console.log("└─ 清理：runtime/ 缓存");
      console.log("");

      await runner.regeneratePlotPlanning(bookId, {
        instruction: options.instruction,
      });

      console.log(`\n✅ "${bookId}" 剧情规划重新生成完成！`);
      console.log(`备份文件位于: backups/${bookId}/`);
    } catch (error) {
      console.error("\n❌ 重新生成失败:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
