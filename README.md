# Activiti Tools - 工作流维护工具

一个便携的 Activiti 6.0 工作流维护工具，基于 Node.js + pkg 打包，可在 Windows 上直接运行。

## 功能特性

- 数据库连接管理：支持 MySQL 和 PostgreSQL
- 连接配置保存：本地 SQLite 存储
- 流程实例查看：当前运行实例列表、详情
- 流程变量管理：查看、添加、修改、删除变量
- 历史任务查看
- 流程定义查看：XML 查看

## 项目结构

```
.
├── package.json
├── src/
│   ├── server.js          # 后端服务器
│   └── public/            # 前端资源
│       ├── index.html
│       ├── css/
│       │   └── style.css
│       └── js/
│           └── app.js
├── config.db              # 本地配置（运行后生成）
└── build/                 # 打包输出
```

## 开发

### 安装依赖

```bash
npm install
```

### 开发运行

```bash
npm run dev
```

然后打开浏览器访问 http://localhost:34567

## 打包

### 安装 pkg

```bash
npm install -g pkg
```

### 打包为 EXE

```bash
npm run build
```

打包后的 EXE 文件位于 `build/activiti-tools.exe`

## 使用说明

### 1. 数据库连接

- 选择数据库类型（MySQL 或 PostgreSQL）
- 填写主机、端口、数据库名、用户名、密码
- 点击"测试连接"验证
- 点击"连接"进入

### 2. 流程实例

- 查看当前运行的流程实例
- 点击"详情"查看实例详情、变量、历史任务

### 3. 流程定义

- 查看已部署的流程定义
- 点击"查看XML"查看流程定义

## 技术栈

- Node.js 18+
- Express
- better-sqlite3 (本地配置)
- mysql2
- pg
- pkg (打包)
- 原生 HTML/CSS/JS (前端)

## 注意事项

- 需要 Activiti 6.0 数据库表结构
- 建议使用只读权限用户连接生产数据库
- 直接操作数据库有风险，请谨慎使用
