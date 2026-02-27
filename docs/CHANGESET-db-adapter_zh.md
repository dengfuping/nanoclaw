# 变更说明：数据库适配层

## 概要

引入可插拔的数据库适配层，同时支持 SQLite（默认）和 seekdb。所有数据库访问统一通过 `IDatabaseAdapter` 接口，可通过 `DB_TYPE` 环境变量无缝切换。

## 动机

- 为后续引入 seekdb（基于 OceanBase）的向量/混合检索能力做准备
- 将应用逻辑与 SQLite 特定 API 解耦
- 完全向后兼容——现有 SQLite 用户无需任何改动

## 架构

```
变更前：src/db.ts（同步 better-sqlite3 调用）
变更后：src/db/index.ts → IDatabaseAdapter → SqliteAdapter | SeekdbAdapter
```

### 新增文件

| 文件 | 行数 | 用途 |
|------|------|------|
| `src/db/index.ts` | 218 | 适配器工厂 + 公共异步 API（替代原 `src/db.ts`） |
| `src/db/types.ts` | 109 | `IDatabaseAdapter` 接口、`ChatInfo`、`RegisteredGroupRow`、`TaskUpdates` 类型定义 |
| `src/db/sqlite.ts` | 580 | SQLite 适配器（内部同步，对外异步 API） |
| `src/db/seekdb.ts` | 550 | seekdb 适配器（MySQL 兼容 SQL 方言，原生异步） |
| `src/db/helpers.ts` | 56 | `RegisteredGroup` 共享映射/序列化辅助函数 |
| `src/integration.test.ts` | 417 | 集成测试——同一套测试分别在 SQLite 和 seekdb 上运行 |
| `scripts/migrate-sqlite-to-seekdb.ts` | 151 | 一次性 ETL 工具：SQLite → seekdb 数据迁移 |

### 删除文件

| 文件 | 行数 | 原因 |
|------|------|------|
| `src/db.ts` | 669 | 被 `src/db/` 适配层替代 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/index.ts` | 导入路径 `db.js` → `db/index.js`，所有 db 调用添加 `await` |
| `src/ipc.ts` | 同上：导入路径 + 异步化 |
| `src/task-scheduler.ts` | 同上 |
| `src/channels/whatsapp.ts` | 同上 |
| `src/config.ts` | `STORE_DIR` 支持通过 `process.env.STORE_DIR` 覆盖，用于测试隔离 |
| `setup/register.ts` | 直接 SQLite 操作替换为 `initDatabase()` + `setRegisteredGroup()` |
| `setup/groups.ts` | 直接 SQLite 操作替换为适配器；内联 WhatsApp 同步脚本改为输出 JSON 到 stdout，由父进程通过适配器写入 |
| `setup/verify.ts` | 直接 SQLite 替换为 `getAllRegisteredGroups()` |
| `setup/environment.ts` | 直接 SQLite 替换为 `getAllRegisteredGroups()` |
| `.env.example` | 新增 `DB_TYPE` 及 seekdb 配置项 |
| `package.json` | 新增 `seekdb` 依赖 |

### 测试文件

| 文件 | 变更 |
|------|------|
| `src/db.test.ts` | 导入路径更新，mock 改为异步返回 |
| `src/channels/whatsapp.test.ts` | db 函数 mock 改为 `Promise.resolve()` |
| `src/ipc-auth.test.ts` | 同上 |
| `src/routing.test.ts` | 同上 |
| `src/task-scheduler.test.ts` | 同上 |

### 文档

| 文件 | 变更 |
|------|------|
| `CLAUDE.md` | Key Files 表：`src/db.ts` → `src/db/` 目录结构 |
| `README.md` | 架构图和关键文件列表更新 |
| `README_zh.md` | 同步更新中文版 |
| `docs/REQUIREMENTS.md` | 新增「Database Layer」架构决策；更新 SQLite 相关描述 |

## 关键设计决策

1. **异步优先 API** — `IDatabaseAdapter` 所有方法返回 `Promise`。SQLite 适配器将同步调用包装为异步；seekdb 原生异步。这是唯一的 API 破坏性变更。

2. **SQL 方言转换** — seekdb 使用 MySQL 兼容语法，处理的主要差异：
   - `AUTOINCREMENT` → `AUTO_INCREMENT`
   - `INSERT OR REPLACE` → `REPLACE INTO`
   - `ON CONFLICT DO UPDATE` → `ON DUPLICATE KEY UPDATE`
   - `INTEGER` 布尔值 → 相同（均支持 0/1）

3. **SQLite 用户零配置** — `DB_TYPE` 默认值为 `sqlite`，无需修改 `.env`。现有的 `store/messages.db` 继续正常工作。

4. **Setup 脚本使用适配器** — 全部 4 个 setup 脚本（`register`、`groups`、`verify`、`environment`）均改为通过适配层操作数据库，不再直接打开 SQLite。`groups.ts` 中的内联 WhatsApp 同步脚本重构为输出 JSON 到 stdout，由父进程通过适配器写入。

## 验证

两种数据库类型均通过 58 项集成断言，覆盖：

| 类别 | 断言数 | 测试内容 |
|------|--------|----------|
| 生命周期 | 3 | init、close、re-init 循环 |
| 会话 | 8 | 存储、更新、upsert、列表、群组同步 |
| 消息 | 7 | 存储、直接存储、查询、过滤机器人消息 |
| 任务 | 9 | CRUD、到期任务、运行日志、级联删除 |
| 路由状态 | 2 | get/set 往返 |
| Session | 4 | get/set、列出全部 |
| 注册群组 | 6 | CRUD、缺失 key |
| Upsert 行为 | 6 | 群组和会话的冲突解决 |
| ContainerConfig JSON | 3 | 嵌套对象序列化/反序列化往返 |
| 特殊字符 | 4 | 撇号、Unicode、emoji |
| channel/isGroup 字段 | 3 | 字段存储和检索 |
| 数据持久性 | 3 | 关闭后重新初始化数据存活 |

运行验证：
```bash
npx vitest run src/integration.test.ts   # 同时运行 SQLite 和 seekdb 测试套件
npx vitest run                           # 全量测试（422 个）
```

## 已知限制

- `store/messages.db` 文件名为历史遗留——实际存储 7 张表，不仅限于消息。为避免迁移复杂性，暂不重命名。
- seekdb 嵌入式模式在进程退出时可能产生 `OB_ABORT` 日志（仅外观影响，无数据丢失）。
- `scripts/migrate-sqlite-to-seekdb.ts` 是一次性 ETL 工具，非自动化迁移。
