# 变更说明：seekdb 语义搜索与能力增强

> 本文档覆盖「数据库适配层」之后的全部变更，包括语义搜索子系统、IPC 搜索工具、代码优化和测试补充。
> 数据库适配层本身的变更详见 [CHANGESET-db-adapter.md](./CHANGESET-db-adapter.md)。

## 概要

基于 seekdb 的 Collection API（向量/混合检索），为 NanoClaw 新增了语义搜索能力。容器中的 Agent 可通过 `search_memory` 工具按语义查找历史消息，也可选择在 Agent 每次执行前自动注入相关上下文。

## NanoClaw seekdb 新增能力评估

### 相比 SQLite 的优势

| 维度 | SQLite | seekdb |
|------|--------|--------|
| 结构化查询 | 完整 SQL 支持 | MySQL 兼容 SQL |
| 向量检索 | 不支持 | 原生 Collection API，余弦相似度 |
| 混合检索 | 不支持 | 全文 + 向量，RRF 融合排序 |
| 嵌入模型 | N/A | 12 种：本地（all-MiniLM-L6-v2、Sentence Transformer、Ollama）及远程（OpenAI、Qwen、Cohere、Jina、VoyageAI 等） |
| 部署模式 | 单文件 | 嵌入式（本地文件）或 Server 模式（远程连接） |

### 新增能力与实际场景价值

| 能力 | 场景 | 价值 |
|------|------|------|
| **消息语义搜索** | Agent 在容器中调用 `search_memory` 查找「之前讨论过的 XX 方案」 | Agent 能跨时间、跨表达方式召回相关历史，而非仅依赖最近 N 条消息 |
| **混合检索降级** | 混合检索失败时自动回退到纯向量检索 | 3 级降级保障可用性：hybrid → vector → empty |
| **时间衰减评分** | 搜索「上次开会讨论的内容」时，最近消息权重更高 | 时间越近越相关，指数衰减 `e^(-0.1h)` |
| **自动上下文注入** | Agent 启动前自动注入与当前话题相关的历史消息 | 零配置增强 Agent 记忆，减少用户手动提供上下文的需要 |
| **异步批量索引** | 消息进入后放入内存队列，5 秒或满 50 条时批量写入 | 不阻塞消息处理主循环，低延迟入库 |

### 设计取舍

- **仅 seekdb 生效**：SQLite 用户完全不受影响，`NoopSearchService` 零开销
- **本地嵌入优先**：默认使用 `@seekdb/default-embed`（all-MiniLM-L6-v2, 384 维），无需外部 API 密钥；可切换至 12 种 seekdb 嵌入模型中的任一种
- **IPC 文件协议**：搜索走 request/response 文件，复用现有 IPC 机制，无需新增网络端口
- **可选启用**：`SEARCH_ENABLED` 可显式开关，`SEARCH_CONTEXT_ENABLED` 控制自动注入

## 架构

```
消息流入
  │
  ├──→ 数据库（结构化存储）
  │
  └──→ SearchService.enqueue() ──→ 批量队列 ──→ SeekdbSearchService.indexMessageBatch()
                                                      │
                                                      ↓
                                              seekdb Collection
                                              (nanoclaw_messages)
                                                      │
Agent 查询 ←── search_memory IPC ←── processSearchRequest() ←── 3 级检索
                                                                  ├ 1. 混合检索 (RRF)
                                                                  ├ 2. 向量检索 (fallback)
                                                                  └ 3. 空结果 (last resort)
```

## 新增文件

| 文件 | 行数 | 用途 |
|------|------|------|
| `src/search/types.ts` | 33 | `ISearchService` 接口、`SearchResult`、`SearchOptions` 类型定义 |
| `src/search/index.ts` | 113 | 搜索服务工厂、批量队列（flush 间隔 5s / 阈值 50）、DI 测试辅助 |
| `src/search/seekdb-search.ts` | 260 | 核心实现：嵌入、索引、3 级检索、时间衰减 |
| `src/search/noop-search.ts` | 20 | 空实现，搜索禁用时使用 |
| `src/search/search.test.ts` | 592 | 34 个单元测试（NoopSearch、SeekdbSearch mock、工厂、批量队列、DI） |
| `src/integration.test.ts` | 416 | 36 个集成测试（SQLite 18 + seekdb 18，均含搜索生命周期） |

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/index.ts` | 启动时 `initSearchService()`，关闭时 `closeSearchService()`；消息入库后 `enqueueForIndexing()`；可选上下文注入 |
| `src/ipc.ts` | 新增 `processSearchRequest()`（支持 DI）和搜索目录轮询；提取 `writeAtomicJson()` 工具函数 |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | 新增 `search_memory` MCP 工具（IPC 请求/轮询响应） |
| `.env.example` | 新增 `SEARCH_ENABLED`、`EMBEDDING_PROVIDER`、`SEARCH_CONTEXT_ENABLED`、`SEARCH_CONTEXT_LIMIT` |
| `src/container-runtime.test.ts` | mock `console.error` 抑制 FATAL 框测试输出 |
| `vitest.config.ts` | 添加 `LOG_LEVEL: 'silent'` 抑制 pino 测试输出 |

## 文档更新

| 文件 | 变更 |
|------|------|
| `CLAUDE.md` | Key Files 表补充 `src/search/` 三个核心文件 |
| `README.md` | 架构描述和关键文件列表更新；清理 "backend" 术语 |
| `README_zh.md` | 同步更新中文版；清理 "后端" 术语 |
| `docs/REQUIREMENTS.md` | 新增 "Semantic Search" 架构决策；"Database Backend" → "Database Layer" |
| `docs/CHANGESET-db-adapter.md` | 更新过时引用（verify-adapter.ts → integration.test.ts）；清理 "backend" 术语 |

## 代码优化

| 项目 | 说明 |
|------|------|
| 消除双重类型断言 | `MessageMetadata` 添加 index signature，不再需要 `as unknown as Record<string, unknown>` |
| 变量命名 | 测试中 `any` → `internal`；代码和文档中 `backend` → `dbType` / "Database Layer" |
| Vitest 4.x 兼容 | `vi.fn<[T], R>()` 旧泛型语法改为 `vi.fn()` |
| 错误信息 | seekdb-search embedding provider 错误信息明确标注"尚未实现" |
| 测试输出 | mock `console.error` 消除 FATAL 框；`LOG_LEVEL: 'silent'` 消除 pino 日志 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SEARCH_ENABLED` | `DB_TYPE=seekdb` 时自动启用 | 显式开关语义搜索 |
| `EMBEDDING_PROVIDER` | `default` | 嵌入模型：`default`（本地 all-MiniLM-L6-v2），或任何 `@seekdb/*` provider（需单独安装） |
| `SEARCH_CONTEXT_ENABLED` | `false` | 是否在 Agent 执行前自动注入相关上下文 |
| `SEARCH_CONTEXT_LIMIT` | `3` | 自动注入的最大消息条数 |

## 测试覆盖

全量 422 个测试通过（34 个测试文件）：

| 类别 | 测试数 | 说明 |
|------|--------|------|
| search 单元测试 | 34 | NoopSearch、SeekdbSearch（mock）、工厂初始化、批量队列、DI 辅助 |
| 集成测试（SQLite） | 18 | DB 适配层 + 搜索生命周期，使用临时目录 |
| 集成测试（seekdb） | 18 | 同上，seekdb 嵌入式模式，独立临时目录 |
| 其他既有测试 | 352 | DB mock、WhatsApp、IPC、路由、任务调度、容器运行时等 |

```bash
npx vitest run                           # 全量测试
npx vitest run src/search/search.test.ts # search 单元测试
npx vitest run src/integration.test.ts   # 集成测试（SQLite + seekdb）
```

## 已知限制

- 非 `default` 嵌入模型需单独安装对应包（如 `npm install @seekdb/openai`）
- seekdb 嵌入式模式在进程退出时可能产生 `OB_ABORT` 日志（无数据影响）
- 搜索索引在内存中排队，进程异常退出可能丢失未 flush 的消息（正常关闭不受影响）
- `search_memory` IPC 基于文件轮询（100ms 间隔），有固有延迟
