# Activiti 工作流运维工具

面向 **Activiti 6.0** 的工作流运维控制台，基于 Node.js + Express + 原生前端，支持 MySQL / PostgreSQL / 瀚高数据库，可用 `pkg` 打包为免安装单文件，启动后自动打开浏览器。

工具只做「运维」该做的事：查看与干预正在运行的流程、修正任务处理人、清理异常作业、修正流程图。它不替代业务系统，也不实现审批界面。

## 主要能力

### 连接与诊断
- 保存多个数据库连接（本机 `config.db`），一键载入、测试、切换
- 连接前自动检测 Activiti 表（`act_hi_procinst`），避免连到空库
- 自动识别 `sys_user` / `sys_role` 的列名（`id`/`user_id`、`realname`/`nick_name` 等），用户表缺失时自动降级显示用户 ID
- 数据库列表、Schema 列表在线拉取；瀚高兼容 PostgreSQL 协议

### 概览
- 运行中实例、待办任务、未分配任务、今日结束、失败作业、流程定义数量
- 最近运行中的流程与失败作业速览，可直接跳转详情

### 流程实例
- 按状态（运行中 / 已结束 / 全部）、流程、关键字（实例 ID / 业务键 / 流程名 / 发起人）筛选，服务端分页
- 实例详情抽屉：基本信息、当前任务、流程变量、流转轨迹、历史任务、流程图
- **挂起 / 激活**实例（同步挂起任务）
- **终止流程**：清理运行时数据并保留历史记录，可填写终止原因
- **彻底删除**：运行时与历史数据全部删除（含轨迹、评论、附件），用于清理测试数据
- **变更流程版本**：把运行中实例迁移到同一流程 Key 的其他版本
- **跳转到任意用户任务节点 / 重激活已结束实例**：按 BPMN 节点的 `assignee`、`candidateUsers`、`candidateGroups` 重新创建任务
- **退回历史节点**：清理该节点之后的审批记录，恢复历史变量；运行中的变量会被保留
- 变量增删改：`string` / `long` / `double` / `boolean` / `json`，同步维护 `act_ru_variable` 与 `act_hi_varinst`
- 历史审批记录修正：任务名、审批人、审批时间、删除原因

### 待办任务
- 全局任务视图，支持关键字、处理人、流程筛选
- 设置 / 清空处理人，维护候选人与参与者，挂起 / 激活任务

### 流程定义
- 全部版本列表：部署时间、运行中实例数、挂起状态
- 查看 / 编辑 BPMN XML（保存前提示受影响的历史实例数量）
- 节点解析：从 XML 中读取用户任务及处理人配置
- 挂起 / 激活流程定义

### 定时作业
- 汇总异步作业、定时器、挂起作业与死信作业
- 查看异常信息、立即执行、重置重试次数、删除作业（并清理异常堆栈）

### 操作日志
- 挂起、终止、删除、跳转、修改变量等高危操作都记录在本地 `audit_logs`，保留最近 1000 条，可清空

## 快速开始

```bash
npm install
npm run dev
# 浏览器访问 http://localhost:34567
```

服务仅监听 `127.0.0.1`，不会暴露到局域网。需要换端口时：

```bash
PORT=8080 npm run dev
```

使用 `--no-open` 或 `NO_OPEN=1` 可禁止自动打开浏览器：

```bash
npm run dev -- --no-open
```

## 打包

```bash
npm run build:win     # Windows
npm run build:linux   # Linux
npm run build:mac     # macOS
```

产物在 `build/` 目录，Windows 下为 `build/activiti-tools.exe`（约 42 MB，无需安装 Node.js）。

使用方式：把 exe 放到任意可写目录，双击运行即可；程序会在 exe 同目录创建 `config.db` 保存连接配置，可通过 `PORT` 环境变量修改监听端口，加 `--no-open` 禁止自动打开浏览器。

打包配置已包含 `src/public/**/*` 与 `sql.js` 的 wasm 文件。仓库内的 GitHub Actions 会在推送 tag 时自动构建并推送二进制。

## 项目结构

```
src/
├── server.js              # Express 服务、Activiti SQL 操作、审计日志
└── public/
    ├── index.html         # 页面骨架
    ├── css/style.css      # 主题样式
    └── js/app.js          # 视图渲染与交互
act.sql                    # Activiti 6.0 MySQL 表结构参考
```

## API 概览

| 分类 | 接口 |
| --- | --- |
| 连接 | `GET /api/connection-status`、`POST /api/test-connection`、`POST /api/test-basic-connection`、`POST /api/get-schemas`、`POST /api/connect`、`POST /api/disconnect`、`GET/POST /api/connections`、`GET/DELETE /api/connections/:id` |
| 概览 | `GET /api/overview`、`GET /api/users` |
| 实例 | `GET /api/instances`、`GET /api/instances/:id`、`POST /api/instances/:id/suspend`、`/activate`、`/terminate`、`/migrate`、`/jump-to-task`、`/jump-to-activity`、`DELETE /api/instances/:id` |
| 变量 | `GET/POST /api/instances/:id/variables`、`DELETE /api/instances/:id/variables/:name` |
| 历史 | `GET /api/instances/:id/history-tasks`、`GET /api/instances/:id/activities`、`PUT /api/history-tasks/:taskId` |
| 任务 | `GET /api/tasks`、`POST /api/tasks/:taskId/set-assignee`、`/suspend`、`/activate`、`GET/POST /api/tasks/:taskId/identitylinks`、`DELETE /api/tasks/:taskId/identitylinks` |
| 定义 | `GET /api/definitions`、`GET/PUT /api/definitions/:id/xml`、`GET /api/definitions/:id/nodes`、`GET /api/definitions/:id/affected-instances`、`POST /api/definitions/:id/suspend` / `/activate` |
| 作业 | `GET /api/jobs`、`POST /api/jobs/:id/execute`、`POST /api/jobs/:id/retries`、`DELETE /api/jobs/:id` |
| 审计 | `GET /api/audit-logs`、`DELETE /api/audit-logs` |

## 数据安全

- 连接配置保存在本地 `config.db`，**密码为明文**，请勿在公共电脑上保存生产库密码
- 终止 / 删除 / 跳转 / 改 XML 均为不可逆操作，界面会二次确认，并写入操作日志
- 修改流程图只覆盖部署资源，不会迁移已运行实例；迁移请使用「变更流程版本」
- 直接修改 Activiti 运行时表属于非常规操作，执行前请确认已备份数据库

## 环境要求

- Node.js >= 18（使用了 `crypto.randomUUID`）
- 数据库账号需要 Activiti 运行时/历史表的读写权限；缺失 `sys_user` 等业务表时工具会降级而不是报错
