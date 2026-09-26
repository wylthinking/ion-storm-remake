import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const inputPath = "src/shared/advanced-ai-weights.json";
const outputPath = "src/shared/advanced-ai-weights.generated.ts";
const payload = JSON.parse(readFileSync(inputPath, "utf8")) as Record<string, unknown>;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `// 本文件由 scripts/sync-advanced-ai-weights.ts 自动生成。\n` +
    `// 不要手动编辑；请编辑 src/shared/advanced-ai-weights.json 后重新构建。\n\n` +
    `export const ADVANCED_AI_TUNING_PAYLOAD = ${JSON.stringify(payload, null, 2)} as const;\n`,
  "utf8",
);

console.log(`已同步高级 AI 参数：${inputPath} -> ${outputPath}`);
