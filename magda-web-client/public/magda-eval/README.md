# Magda GeoSQL 评测（三数据集）

本目录存放 **Magda 全链路 GeoSQL 生成** 评测用例（自然语言 + `gold_sql`），与 `eval_data/data.md` 中的三库及 **5000 条导入子集** 约定一致。

## 目录结构

```text
magda-eval/
  README.md                 # 本文件
  cases/
    land_zones.jsonl        # Land Development Zones，24 条
    manningham_trees.jsonl  # Manningham Street Trees，24 条
    road_segment.jsonl      # Road Segment，24 条
  scripts/
    validate-cases.mjs      # 校验 JSONL 格式（无需安装依赖）
```

## 用例行格式（JSON Lines）

每行一个 JSON 对象，字段如下：

| 字段                 | 必填 | 说明                                                                                                                                                   |
| -------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                 | 是   | 稳定唯一 id，建议 `{dataset}-{序号}`。                                                                                                                 |
| `dataset_slug`       | 是   | `land_zones` \| `manningham_trees` \| `road_segment`。                                                                                                 |
| `distribution_index` | 否   | 数据集页上空间分发的索引；单空间文件时可省略，由工具自动选唯一分发。                                                                                   |
| `question`           | 是   | 自然语言问题（与真实用户提问风格一致）。                                                                                                               |
| `gold_sql`           | 是   | 针对表 **`features`** 的单条 `SELECT`/`WITH ... SELECT`；**固定 `ORDER BY` 与列别名**，便于结果 hash。                                                 |
| `tags`               | 否   | 题型标签：`ExecutionTargetPattern`（如 `FILTER_COUNT`）、难度 `L1`/`L2`/`L3`、结果形态 `scalar`/`rows`，以及辅助标签如 `filter`、`geography_measure`。 |

## 题型矩阵（72 题，每库 24 — 均衡 v2）

三库共 **72** 条，`case_id` 仍为 `zones-*` / `trees-*` / `road-*`（001–024）。**能力族按库对齐**，避免单库过度偏重某一类（如 trees 纯计数、road 纯周长阈值）。

| 能力族                      | land_zones | manningham_trees | road_segment |
| --------------------------- | ---------- | ---------------- | ------------ |
| A 计数 `FILTER_COUNT`       | 8          | 8                | 5            |
| B 分组 `AGGREGATE_GROUP_BY` | 4          | 6                | 1            |
| C 列表 `LIST_ROWS`          | 2          | 4                | 2            |
| D 量算 `MEASUREMENT`        | 5          | —                | 8            |
| E 空间过滤 `SPATIAL_FILTER` | 3          | 2                | 5            |
| F 最近邻 `SPATIAL_NEAREST`  | —          | 1                | —            |
| G 复合 `MIXED`              | 2          | 3                | 3            |

**全库合计**：计数 21 · 分组 11 · 列表 8 · 量算 13 · 空间滤 10 · 最近邻 1 · 复合 8。

难度（每库）：L1 约 6–7 · L2 约 10–12 · L3 约 5–8。Road 以 **MultiPolygon 周长**（`ST_Perimeter`）与 **长度**（`ST_Length`）分工；Trees 无面量算，用 **距离/纬度** 空间题替代。

| `target_pattern`     | 典型 L1            | 典型 L2             | 典型 L3             |
| -------------------- | ------------------ | ------------------- | ------------------- |
| `FILTER_COUNT`       | 全表、单字段 `=`   | `ILIKE`、distinct   | 多字段 `AND`        |
| `AGGREGATE_GROUP_BY` | 按几何类型（road） | Top-N 单维          | 先 filter 再 Top-N  |
| `LIST_ROWS`          | 固定列 + `LIMIT`   | 带 WHERE / 排序     | —                   |
| `MEASUREMENT`        | —                  | 属性或 `ST_*` 聚合  | 极值、valid+面积    |
| `SPATIAL_FILTER`     | —                  | 阈值、valid/invalid | 比均值、子查询      |
| `SPATIAL_NEAREST`    | —                  | —                   | 仅 trees（King St） |
| `MIXED`              | —                  | —                   | 属性+空间组合       |

## 校验用例文件

```bash
node magda-eval/scripts/validate-cases.mjs
```

## 已有报告：层级统计提取（无需重跑评测）

对已下载的 GeoSQL 评测 JSON（单库或三库 `magda-geosql-eval-all-*.json`），从 `cases/*.jsonl` 注入 **5 层 hierarchy** 并生成分层汇总：

```bash
node magda-eval/scripts/extract-report-hierarchy.mjs eval_report/magda-geosql-eval-all-2026-05-22T12-13-17-235Z.json --csv
```

| 输出文件                          | 内容                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| `<report>-hierarchy.json`         | 原报告 + 每题 `hierarchy` + 顶层 `hierarchy_extraction` 摘要         |
| `<report>-hierarchy-summary.json` | 仅分层 rollup（`overall` / `by_dataset` / `by_family` / `per_case`） |
| `<report>-cases.csv`              | 每题一行：path、family、pattern、Layer B/EPR/routing                 |
| `<report>-hierarchy.csv`          | 可选 `--csv`：树形路径展开表（各层 n、通过率）                       |

层级路径约定（与下文题型矩阵一致）：

`dataset_slug / family / target_pattern / subtype / L1|L2|L3 / scalar|rows`

分类逻辑在 `scripts/caseHierarchy.mjs`（可被其他脚本 `import`）。

## 浏览器内全链路 Runner（已接入 Magda Web）

1. 在 **`magda/magda-web-client`** 执行 `yarn sync-magda-eval`，将本目录同步到 `public/magda-eval/`（构建/开发服务器才能 `fetch` 到 manifest 与 JSONL）。
2. 在 `magda-eval/manifest.json` 中为各 `dataset_slug` 填写 **`magda_dataset_id`**（与 URL `/dataset/<id>` 一致）；也可在评测页输入 id，失焦后写入浏览器 `localStorage` 键 `magdaGeoSqlEvalDatasetIds` 覆盖 manifest。
3. 启动 Web 客户端，打开 **`/geosql-eval`**（需服务端开启 `enableChatbot` 与 `enablePglitePostgis`）。
4. 选择 slug、确认数据集已从 registry 加载后，点击 **「运行评测」**。**Eval pipeline**：**Full pipeline** 依次 `warmupOnly` 再 `stream(question)`（AgentChain + task-spec）；**Baseline direct** 仅 warmup 导入 `features`，每题用 profile YAML + 问题单次 LLM 出 SQL（无路由/契约）。二者 Layer A/B 相同；报告 `meta.eval_pipeline` 为 `agent` 或 `baseline_direct`。
5. **运行日志** 面板会显示 harness 阶段（warmup / 逐题 / 汇总）及每题 **System Logs**；评测结束后可 **下载 JSON 报告**（含 Layer A/B 逐条明细 + 完整日志）或 **CSV 摘要**（对应终稿 §4.3 / Table 10 风格汇总字段）。

### 报告中的耗时与 Token（JSON / CSV）

下载的 JSON 除准确率外，还会记录 **墙钟时间** 与 **LLM token**（从 System Log 中的 `Planner/Intro/GeoTaskInterpreter/SpatialIntentRouter LLM usage: prompt=…` 行解析）：

| 位置                                    | 字段                                             | 含义                                                                                                             |
| --------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `meta`                                  | `llm_provider`, `openai_model`                   | `webllm` 或 `openai` 及模型名                                                                                    |
| `meta`                                  | `run_timing`                                     | 本库整轮：`wall_ms`、`warmup_wall_ms`、`cases_wall_ms_sum`、`started_at` / `finished_at`                         |
| `meta`                                  | `llm_usage_total`                                | 本库各题 token 汇总（`prompt_tokens` / `completion_tokens` / `total_tokens` / `call_count`，`by_source` 分来源） |
| `summary`                               | `timing_ms_total`, `timing_ms_mean`, `llm_usage` | 逐题 `timing.wall_ms` 的合计/均值与 token 汇总                                                                   |
| 每题 `cases[]`                          | `timing`, `llm_usage`                            | 单题墙钟与 token                                                                                                 |
| 三库联跑 `magda-geosql-eval-all-*.json` | `meta.run_timing`, `meta.llm_usage_total`        | 各库 `run_timing.wall_ms` 相加、token 跨库汇总                                                                   |

CSV 摘要含 `timing_ms_total` / `llm_total_tokens` 等汇总行，以及逐题的 `timing_ms`、`llm_total_tokens` 列。

**Layer A**：SA（首次/最终 SQL 可读性）、EPR（首次/最终 PostGIS 执行是否成功）、repair gain、错误分桶（syntax/schema/function/type/crs/runtime/routing）。  
**Layer B**：`gold_sql` 与模型最终 SQL 结果集的确定性指纹是否一致。

更细的 GeoSQL 链路与日志顺序见仓库内 **`工作日志/spatial_sql_flow.md`**（若存在）。

## Schema 与问题表述

- 三库字段与几何约定见 **[SCHEMA.md](./SCHEMA.md)**（与 Console 实测 / `gold_sql` 一致）。
- 用例为 **v2 均衡集**：自然语言口语化；**`gold_sql` 与 `case_id` 槽位已按上表重组**（与旧报告不可直接对比 Layer B，需重跑评测）。
- 属性 key 以 Console 实测为准；**勿**使用错误别名（如 Zones 的 `zone_meaning`）。
- Trees 的 `height`、`dbh` 为 **字符串**，gold 中勿 `::numeric`。
- Road 几何为 **MultiPolygon**；周长题用 `ST_Perimeter`，勿与线要素 `ST_Length` 混淆。
