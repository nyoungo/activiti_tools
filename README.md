# Activiti 工作流维护工具

一个基于 Node.js + pkg 打包的便携 Activiti 6.0 工作流维护工具，支持 Windows/macOS/Linux 平台，单文件运行无需依赖。

## 功能特性

- 数据库连接管理：支持 MySQL 和 PostgreSQL
- 连接配置保存：本地 SQLite 数据库存储
- 流程实例查看：当前运行实例列表、分页、搜索
- 流程实例详情：基本信息、当前任务、流程变量、历史任务
- 流程变量管理：查看、添加、修改、删除变量
- 流程定义查看：列表展示、XML 查看
- 单文件运行：pkg 打包后无需 Node.js 环境

## 项目结构

```
/workspace/
├── package.json              # 项目配置和依赖
├── .gitignore               # Git 忽略配置
├── .github/
│   └── workflows/
│       ├── build-release.yml    # 单平台打包 GitHub Action
│       └── build-multiplatform.yml  # 多平台打包 GitHub Action
├── README.md                # 本文件
├── GITHUB_ACTIONS.md        # GitHub Action 使用说明
└── src/
    ├── server.js            # Express 后端服务
    └── public/              # 前端资源
        ├── index.html       # 主页面
        ├── css/
        │   └── style.css    # 样式文件
        └── js/
            └── app.js       # 前端交互逻辑
```

## 开发使用

### 安装依赖

```bash
npm install
```

### 开发运行

```bash
npm run dev
```

然后打开浏览器访问 http://localhost:34567

### 本地打包

```bash
npm install -g pkg
npm run build:win      # Windows 平台
npm run build:linux    # Linux 平台
npm run build:mac      # macOS 平台
npm run build:all      # 所有平台
```

打包后的文件在 `build/` 目录下

## 使用说明

### 1. 数据库连接

- 选择数据库类型（MySQL / PostgreSQL）
- 填写主机、端口、数据库名、用户名、密码
- 点击「测试连接」验证连接
- 点击「保存配置」保存到本地
- 点击「连接」进入系统

### 2. 流程实例

- 查看当前运行的流程实例
- 支持按流程名、Key、业务 Key 搜索
- 点击「详情」查看实例详情

### 3. 流程变量管理

在流程实例详情页面可以：
- 查看现有变量
- 添加新变量
- 修改变量值和类型
- 删除变量

### 4. 流程定义

- 查看已部署的流程定义
- 点击「查看 XML」查看流程定义源码

## GitHub Action 自动打包

### 创建 Tag 触发

```bash
git tag -a v1.0.0 -m "Release version 1.0.0"
git push origin v1.0.0
```

### 手动触发

1. 访问仓库 Actions 页面
2. 选择「Build Windows Release」
3. 点击「Run workflow」

### 多平台打包

使用 `.github/workflows/build-multiplatform.yml` 可以同时打包三个平台

## 技术栈

- Node.js 18+
- Express - Web 服务框架
- better-sqlite3/sql.js - 本地 SQLite 数据库
- mysql2 - MySQL 驱动
- pg - PostgreSQL 驱动
- pkg - 打包工具
- 原生 HTML/CSS/JS - 前端界面

## 注意事项

- 支持 Activiti 6.0 数据库表结构
- 建议使用只读权限用户连接生产数据库
- 直接操作数据库有风险，生产环境谨慎使用

## License

MIT
