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

## 题型矩阵（每库 24 题）

三库各 **24 条**（001–010 保留原 pilot；011–024 按 `ExecutionTargetPattern` × 难度扩充），共 **72 条**。

| 槽位     | `target_pattern`     | L1                | L2                    | L3                                       |
| -------- | -------------------- | ----------------- | --------------------- | ---------------------------------------- |
| 计数     | `FILTER_COUNT`       | 全表 / 单字段 `=` | `ILIKE`、双字段 `AND` | 多条件 / 空串陷阱 / `DISTINCT` 计数      |
| 分组     | `AGGREGATE_GROUP_BY` | —                 | Top-N 单维            | 过滤后分组 Top-N                         |
| 列表     | `LIST_ROWS`          | 固定列 + `LIMIT`  | 带过滤 + 排序         | —                                        |
| 量算     | `MEASUREMENT`        | —                 | 属性或 `ST_*` 聚合    | `::geography` 标量 / 极值                |
| 空间过滤 | `SPATIAL_FILTER`     | 几何类型          | 阈值比较              | 子查询 vs 均值                           |
| 最近邻   | `SPATIAL_NEAREST`    | —                 | —                     | Trees：`King`/`Str` 参考 + `ST_Distance` |
| 复合     | `MIXED`              | —                 | 属性 + 空间谓词       | 子查询 / 数值范围                        |

Land Zones 011–024 覆盖 `LIST_ROWS`、`SPATIAL_FILTER`、`MIXED` 等原 10 题未覆盖模式；Road 011–024 以 **`ST_Perimeter(geom::geography)`** 补充 MultiPolygon 周长量算（001–010 保留 `ST_Length` 约定）。

## 校验用例文件

```bash
node magda-eval/scripts/validate-cases.mjs
```

## 浏览器内全链路 Runner（已接入 Magda Web）

1. 在 **`magda/magda-web-client`** 执行 `yarn sync-magda-eval`，将本目录同步到 `public/magda-eval/`（构建/开发服务器才能 `fetch` 到 manifest 与 JSONL）。
2. 在 `magda-eval/manifest.json` 中为各 `dataset_slug` 填写 **`magda_dataset_id`**（与 URL `/dataset/<id>` 一致）；也可在评测页输入 id，失焦后写入浏览器 `localStorage` 键 `magdaGeoSqlEvalDatasetIds` 覆盖 manifest。
3. 启动 Web 客户端，打开 **`/geosql-eval`**（需服务端开启 `enableChatbot` 与 `enablePglitePostgis`）。
4. 选择 slug、确认数据集已从 registry 加载后，点击 **「运行评测」**：依次 `warmupOnly` 导入空间 profile，再对每题 `stream(question, { geoEvalCaptureExecutedSql: true })`，将捕获的最终 SQL 与 `gold_sql` 的查询结果做 **行指纹** 比对。
5. **运行日志** 面板会显示 harness 阶段（warmup / 逐题 / 汇总）及每题 **System Logs**；评测结束后可 **下载 JSON 报告**（含 Layer A/B 逐条明细 + 完整日志）或 **CSV 摘要**（对应终稿 §4.3 / Table 10 风格汇总字段）。

**Layer A**：SA（首次/最终 SQL 可读性）、EPR（首次/最终 PostGIS 执行是否成功）、repair gain、错误分桶（syntax/schema/function/type/crs/runtime/routing）。  
**Layer B**：`gold_sql` 与模型最终 SQL 结果集的确定性指纹是否一致。

更细的 GeoSQL 链路与日志顺序见仓库内 **`工作日志/spatial_sql_flow.md`**（若存在）。

## 与 `data.md` 的一致性

- 属性 key 以 `eval_data/data.md` 的 Console 实测为准；**勿**使用文档中标为错误的别名（如 Zones 的 `zone_meaning` 等）。
- Trees 的 `height`、`dbh` 为 **字符串**，gold 中勿 `::numeric`。
- Road 几何为 **MultiPolygon**，属性几乎无差异，gold 以空间量算为主。
