下面是按**当前实际目录**整理的架构图。核心源码集中在 `src/mastra/` 下的 3 个文件。

```mermaid
flowchart TD
    U["用户 / Mastra Studio"] --> I

    subgraph SRC["src/mastra/"]
        I["index.ts<br/>Mastra 入口与注册"]
        subgraph AGENTS["agents/"]
            A["agent.ts<br/>Agent 定义"]
        end
        subgraph TOOLS["tools/"]
            T["schedule-tools.ts<br/>创建 / 暂停定时任务"]
        end
        subgraph PUBLIC["public/ · 运行时数据"]
            W["workspace/ · Agent 工作文件"]
            DB["mastra.db · 记忆与任务等数据"]
            DK["mastra.duckdb · 可观测性数据"]
        end
    end

    I -->|注册 Agent| A
    I -->|注册工具| T
    I -->|LibSQL 存储| DB
    I -->|DuckDB + Observability| DK
    A -->|调用定时工具| T
    A -->|LocalFilesystem / LocalSandbox| W
    A -->|Memory| DB
    A -->|模型调用| M["OpenAI 模型"]
    T -->|调用 Mastra schedules| S["定时任务调度"]
    S -.->|按计划运行| A
```

| 目录或文件 | 作用 |
|---|---|
| [src/mastra/index.ts](/Users/nerosun/裂缝中的阳光/sxy/日常/code/nerosun-harness/nero-agent/src/mastra/index.ts) | 注册 Agent 和工具；配置 LibSQL、DuckDB 与可观测性。 |
| [src/mastra/agents/agent.ts](/Users/nerosun/裂缝中的阳光/sxy/日常/code/nerosun-harness/nero-agent/src/mastra/agents/agent.ts) | 配置模型、记忆、工作区、内置网络工具及定时工具。 |
| [src/mastra/tools/schedule-tools.ts](/Users/nerosun/裂缝中的阳光/sxy/日常/code/nerosun-harness/nero-agent/src/mastra/tools/schedule-tools.ts) | 实现 `start_schedule` 和 `stop_schedule`。 |
| `src/mastra/public/` | 本地运行时数据；`workspace/` 会在使用时创建。 |
| `.mastra/` | Mastra 构建和开发运行时生成目录，不是业务源码。 |

启动入口是 `package.json` 的 `npm run dev`；目前项目没有单独的工作流或前端业务源码。