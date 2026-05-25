# Activiti 6.0.0 工作流维护工具实现方案（便携版）

## 一、项目概述

### 1.1 项目目标
开发一个**便携小巧**的Activiti 6.0.0工作流维护工具，**双击即可在Windows上运行**，无需安装任何运行环境。支持MySQL和PostgreSQL数据库连接，提供流程实例管理、节点编辑、流程跳转回退、变量管理等功能。

### 1.2 核心功能
- **数据库连接**：支持MySQL和PostgreSQL
- **流程实例列表**：展示当前运行的所有流程
- **流程图查看/编辑**：支持文本形式的流程定义编辑
- **节点管理**：节点信息查看与编辑
- **流程控制**：流程跳转、回退
- **变量管理**：流程变量和任务变量的查看与修改
- **便携性**：单exe文件，无外部依赖

## 二、技术选型对比

### 2.1 可选方案对比

| 方案 | 技术栈 | 体积 | 启动速度 | 学习成本 | 推荐度 |
|------|--------|------|----------|----------|--------|
| **方案A** | Node.js + Electron + Vue 3 | ~120-180MB | 中 | 低（前端友好） | ⭐⭐⭐⭐ |
| **方案B** | Node.js + pkg + 原生GUI | ~50-80MB | 快 | 中 | ⭐⭐⭐ |
| **方案C** | Go + Wails | ~15-25MB | 快 | 高 | ⭐⭐⭐⭐⭐ |
| 方案D | Java + Swing | ~100MB+ | 慢 | 中 | ⭐⭐ |

---

## 三、Node.js方案详情（方案A：推荐）

### 3.1 技术栈（Node.js + Electron + Vue 3）
- **Node.js 18+**：后端运行时
- **Electron 28+**：桌面应用框架（内嵌Chromium + Node.js）
- **Vue 3 + Element Plus**：前端UI框架
- **better-sqlite3**：本地SQLite存储
- **mysql2**：MySQL驱动
- **pg**：PostgreSQL驱动
- **electron-builder**：打包工具

### 3.2 为什么这个方案？
✅ **前端开发友好**：熟悉的Vue 3 + Element Plus  
✅ **丰富的生态**：npm海量包可用  
✅ **跨平台**：支持Windows/Mac/Linux  
✅ **成熟稳定**：Electron广泛应用（VS Code、Discord等）  

⚠️ **缺点**：体积较大（~120-180MB）

### 3.3 项目结构
```
/workspace/
├── package.json
├── electron-builder.json
├── src/
│   ├── main/           # Electron主进程
│   │   ├── main.js
│   │   ├── database.js
│   │   ├── activiti.js
│   │   └── preload.js
│   └── renderer/       # 渲染进程（Vue 3）
│       ├── index.html
│       ├── main.js
│       ├── App.vue
│       ├── components/
│       ├── views/
│       └── api/
└── build/
    └── activiti-tools Setup.exe  # 安装包
    └── activiti-tools.exe        # 便携版（zip解压即用）
```

---

## 四、Node.js方案详情（方案B：轻量版）

### 4.1 技术栈（Node.js + pkg + 原生GUI）
- **Node.js 18+**：后端运行时
- **pkg**：将Node.js打包为exe
- **pkg-fetch**：预编译Node二进制
- **node-webkit (nw.js)** 或 **neutralino**：轻量GUI
- 或 **Express + 浏览器**：启动本地服务器自动打开浏览器
- **better-sqlite3**：本地SQLite存储
- **mysql2**：MySQL驱动
- **pg**：PostgreSQL驱动

### 4.2 为什么这个方案？
✅ **体积适中**：~50-80MB  
✅ **Node.js生态**：npm包可用  
✅ **无需Chromium**：使用系统浏览器或轻量WebView  

### 4.3 项目结构
```
/workspace/
├── package.json
├── src/
│   ├── server.js       # Express服务器
│   ├── database.js
│   ├── activiti.js
│   └── public/         # 前端静态文件
│       ├── index.html
│       ├── css/
│       └── js/
└── build/
    └── activiti-tools.exe  # 单exe，启动本地服务器
```

---

## 五、继续Go方案（方案C）

### 5.1 技术栈
- **Go 1.21+**：后端语言，编译原生exe，无依赖
- **Wails v2**：Go + Web技术构建桌面应用
- **HTML5 + CSS3 + JavaScript (Vanilla JS)**：前端界面（无需框架，减小体积）
- **SQLite**：本地配置存储
- **MySQL Driver (github.com/go-sql-driver/mysql)**：MySQL驱动
- **PostgreSQL Driver (github.com/lib/pq)**：PostgreSQL驱动

### 5.2 为什么这个方案？
✅ **体积最小**：~15-25MB  
✅ **启动最快**：原生编译  
✅ **真·无依赖**：无需Node.js、无需JRE  
✅ **单exe文件**：双击即用  

⚠️ **缺点**：Go语言学习成本

### 2.4 方案对比总结
| 对比项 | 方案A (Electron) | 方案B (pkg+浏览器) | 方案C (Go+Wails) |
|--------|------------------|----------|------------|
| 体积 | ~120-180MB | ~50-80MB | ~15-25MB |
| 启动速度 | 中 | 快 | 快 |
| 依赖 | 无需 | 无需 | 无需 |
| 单文件 | 是（zip） | 是 | 是 |
| 开发友好 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ |

---

## 六、Node.js方案A详细实现（Electron）

### 6.1 package.json配置
```json
{
  "name": "activiti-tools",
  "version": "1.0.0",
  "main": "src/main/main.js",
  "scripts": {
    "dev": "electron .",
    "build": "electron-builder"
  },
  "dependencies": {
    "better-sqlite3": "^9.0.0",
    "mysql2": "^3.6.0",
    "pg": "^8.11.0"
  },
  "devDependencies": {
    "electron": "^28.0.0",
    "electron-builder": "^24.9.0",
    "vite": "^5.0.0",
    "vue": "^3.4.0",
    "element-plus": "^2.5.0"
  }
}
```

### 6.2 electron-builder.json配置
```json
{
  "appId": "com.activiti.tools",
  "productName": "Activiti Tools",
  "directories": { "output": "build" },
  "files": ["src/**/*", "package.json"],
  "win": {
    "target": [
      { "target": "nsis", "arch": ["x64"] },
      { "target": "portable", "arch": ["x64"] }
    ]
  },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true }
}
```

### 6.3 主进程（main.js）
```javascript
const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true
    }
  })
  
  if (process.env.NODE_ENV === 'dev') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(createWindow)

// IPC处理
ipcMain.handle('test-connection', async (event, config) => {
  // 测试数据库连接
})

ipcMain.handle('list-instances', async (event, page, size, keyword) => {
  // 查询流程实例
})
```

### 6.4 预加载脚本（preload.js）
```javascript
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  testConnection: (config) => ipcRenderer.invoke('test-connection', config),
  listInstances: (page, size, keyword) => ipcRenderer.invoke('list-instances', page, size, keyword),
  getInstance: (id) => ipcRenderer.invoke('get-instance', id),
  // ... 更多方法
})
```

---

## 七、Node.js方案B详细实现（pkg+浏览器）

### 7.1 package.json配置
```json
{
  "name": "activiti-tools",
  "version": "1.0.0",
  "bin": "src/server.js",
  "scripts": {
    "dev": "node src/server.js",
    "build": "pkg . --targets node18-win-x64 --output build/activiti-tools.exe"
  },
  "dependencies": {
    "express": "^4.18.0",
    "better-sqlite3": "^9.0.0",
    "mysql2": "^3.6.0",
    "pg": "^8.11.0",
    "open": "^9.0.0"
  },
  "devDependencies": {
    "pkg": "^5.8.0"
  },
  "pkg": {
    "assets": ["src/public/**/*"],
    "targets": ["node18-win-x64"],
    "outputPath": "build"
  }
}
```

### 7.2 服务器（server.js）
```javascript
const express = require('express')
const path = require('path')
const open = require('open')

const app = express()
const PORT = 34567

// 静态文件
app.use(express.static(path.join(__dirname, 'public')))
app.use(express.json())

// API路由
app.post('/api/connect', async (req, res) => { /* ... */ })
app.get('/api/instances', async (req, res) => { /* ... */ })
// ... 更多API

// 启动服务器并打开浏览器
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`)
  open(`http://localhost:${PORT}`)
})
```

---

## 八、推荐选择

| 你的情况 | 推荐方案 |
|----------|----------|
| 前端开发者，熟悉Vue/React | **方案A（Electron）** |
| 希望体积尽量小，愿意学Go | **方案C（Go+Wails）** |
| 折中方案，体积适中 | **方案B（pkg+浏览器）** |

---

## 以下为Go方案内容（保留参考）

### 项目结构
```
/workspace/
├── main.go               # 入口文件
├── go.mod                # Go依赖
├── build/                # 编译输出
│   └── activiti-tools.exe
├── frontend/             # 前端资源
│   ├── index.html
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js
│       ├── api.js
│       └── components.js
├── internal/             # Go内部代码
│   ├── database/         # 数据库操作
│   ├── activiti/         # Activiti相关操作
│   ├── handlers/         # API处理器
│   └── models/           # 数据模型
├── appicon.png           # 应用图标
└── wails.json            # Wails配置
```

## 九、核心功能设计（Go版本，Node.js同理）

### 3.1 数据库连接模块

#### 3.1.1 功能描述
支持动态连接MySQL和PostgreSQL数据库，提供连接配置界面，保存配置到本地SQLite。

#### 3.1.2 数据模型
```go
type DatabaseConfig struct {
    ID       int64  `json:"id"`
    Name     string `json:"name"`     // 配置名称
    DBType   string `json:"dbType"`   // mysql 或 postgresql
    Host     string `json:"host"`
    Port     int    `json:"port"`
    Database string `json:"database"`
    Username string `json:"username"`
    Password string `json:"password"`
}

type ConnectionStatus struct {
    Success bool   `json:"success"`
    Message string `json:"message"`
}
```

#### 3.1.3 Wails绑定方法
```go
// 测试连接
func (a *App) TestConnection(config DatabaseConfig) (ConnectionStatus, error)

// 保存配置
func (a *App) SaveConnection(config DatabaseConfig) (int64, error)

// 获取保存的配置列表
func (a *App) ListConnections() ([]DatabaseConfig, error)

// 连接到数据库
func (a *App) Connect(config DatabaseConfig) (ConnectionStatus, error)
```

#### 3.1.4 实现要点
- 动态创建数据库连接
- 使用database/sql连接池
- 连接有效性验证
- 本地SQLite保存配置

### 3.2 流程实例列表模块

#### 3.2.1 功能描述
直接查询Activiti数据库表，展示当前正在运行的所有流程实例，支持分页和搜索。

#### 3.2.2 数据模型
```go
type ProcessInstance struct {
    ID                  string    `json:"id"`
    ProcDefID           string    `json:"procDefId"`
    ProcDefName        string    `json:"procDefName"`
    ProcDefKey         string    `json:"procDefKey"`
    StartTime          time.Time `json:"startTime"`
    StartUserID        string    `json:"startUserId"`
    BusinessKey        string    `json:"businessKey"`
    CurrentTasks       []Task    `json:"currentTasks"`
}

type Task struct {
    ID          string `json:"id"`
    Name        string `json:"name"`
    Assignee    string `json:"assignee"`
    CreateTime  time.Time `json:"createTime"`
}
```

#### 3.2.3 Wails绑定方法
```go
// 获取流程实例列表
func (a *App) ListProcessInstances(page, size int, keyword string) ([]ProcessInstance, int, error)

// 获取流程实例详情
func (a *App) GetProcessInstance(instanceID string) (ProcessInstance, error)
```

#### 3.2.4 Activiti表映射
直接查询以下表：
- `act_ru_execution`：运行时流程实例
- `act_ru_task`：运行时任务
- `act_re_procdef`：流程定义

### 3.3 流程定义编辑模块

#### 3.3.1 功能描述
- 从`act_ge_bytearray`表读取流程定义XML
- 支持文本形式编辑流程定义
- 保存到数据库

#### 3.3.2 数据模型
```go
type ProcessDefinition struct {
    ID      string `json:"id"`
    Key     string `json:"key"`
    Name    string `json:"name"`
    Version int    `json:"version"`
    XML     string `json:"xml"`
}
```

#### 3.3.3 Wails绑定方法
```go
// 获取流程定义列表
func (a *App) ListProcessDefinitions() ([]ProcessDefinition, error)

// 获取流程定义XML
func (a *App) GetProcessDefinitionXML(defID string) (string, error)

// 更新流程定义
func (a *App) UpdateProcessDefinitionXML(defID string, xml string) error
```

### 3.4 节点管理模块

#### 3.4.1 功能描述
- 解析BPMN XML获取节点信息
- 查看流程节点信息
- 编辑节点属性

#### 3.4.2 数据模型
```go
type NodeInfo struct {
    ID         string                 `json:"id"`
    Name       string                 `json:"name"`
    Type       string                 `json:"type"` // userTask, serviceTask, gateway等
    Properties map[string]interface{} `json:"properties"`
}
```

#### 3.4.3 Wails绑定方法
```go
// 获取流程节点列表
func (a *App) GetProcessNodes(defID string) ([]NodeInfo, error)
```

### 3.5 流程控制模块

#### 3.5.1 功能描述
- 流程跳转：直接操作Activiti表实现跳转
- 流程回退：将流程回退到指定历史节点

#### 3.5.2 实现方案
直接操作Activiti数据库表：
- `act_ru_execution`：更新执行流
- `act_ru_task`：创建/删除任务
- `act_ru_variable`：处理变量
- `act_hi_actinst`：历史活动实例

#### 3.5.3 Wails绑定方法
```go
// 流程跳转
func (a *App) JumpToNode(instanceID, targetNodeID string, variables map[string]interface{}) error

// 流程回退
func (a *App) RollbackToTask(instanceID, targetHistoryTaskID string) error

// 获取可跳转的节点列表
func (a *App) GetAvailableNodes(instanceID string) ([]NodeInfo, error)

// 获取历史任务列表
func (a *App) GetHistoryTasks(instanceID string) ([]Task, error)
```

### 3.6 变量管理模块

#### 3.6.1 功能描述
- 查询`act_ru_variable`表查看变量
- 添加、修改变量
- 删除变量

#### 3.6.2 数据模型
```go
type Variable struct {
    Name  string      `json:"name"`
    Type  string      `json:"type"`
    Value interface{} `json:"value"`
}
```

#### 3.6.3 Wails绑定方法
```go
// 获取流程变量
func (a *App) GetProcessVariables(instanceID string) ([]Variable, error)

// 设置流程变量
func (a *App) SetProcessVariable(instanceID string, name string, value interface{}) error

// 删除流程变量
func (a *App) DeleteProcessVariable(instanceID string, name string) error
```

## 四、Activiti 表结构（关键表）

### 4.1 运行时表
| 表名 | 说明 |
|------|------|
| act_ru_execution | 流程执行实例 |
| act_ru_task | 任务实例 |
| act_ru_variable | 流程变量 |
| act_ru_identitylink | 任务相关人员 |

### 4.2 历史表
| 表名 | 说明 |
|------|------|
| act_hi_procinst | 历史流程实例 |
| act_hi_taskinst | 历史任务实例 |
| act_hi_varinst | 历史变量 |
| act_hi_actinst | 历史活动实例 |

### 4.3 流程定义表
| 表名 | 说明 |
|------|------|
| act_re_procdef | 流程定义 |
| act_re_deployment | 部署信息 |
| act_ge_bytearray | 二进制资源（XML） |

## 五、前端页面设计（纯HTML/CSS/JS）

### 5.1 页面结构（单页应用）
```html
<div id="app">
    <!-- 侧边栏导航 -->
    <nav class="sidebar">...</nav>
    
    <!-- 主内容区 -->
    <main class="main-content">
        <!-- 数据库连接页 -->
        <section id="page-connection" class="page active">...</section>
        
        <!-- 流程实例列表页 -->
        <section id="page-instances" class="page">...</section>
        
        <!-- 流程详情页 -->
        <section id="page-detail" class="page">...</section>
        
        <!-- 流程定义编辑页 -->
        <section id="page-definition" class="page">...</section>
    </main>
</div>
```

### 5.2 关键页面

#### 5.2.1 数据库连接页
- 保存的配置下拉框
- 连接表单（类型、主机、端口、数据库、用户名、密码）
- 测试连接按钮
- 连接按钮

#### 5.2.2 流程实例列表页
- 搜索框
- 流程实例表格（ID、名称、开始时间、当前任务）
- 分页控件
- 操作列（查看详情、编辑）

#### 5.2.3 流程详情页
- 基本信息展示
- 当前任务列表
- 流程变量表格（支持增删改）
- 流程操作区（跳转、回退）
- 流程定义XML查看

### 5.3 UI框架
使用轻量级CSS框架：
- **Milligram** 或 **Picnic CSS**：极小体积（~10KB）
- 或纯CSS自定义样式

## 六、实施步骤

### 阶段一：项目初始化
1. 安装Wails v2
2. 初始化Wails项目
3. 配置项目依赖（MySQL/PostgreSQL驱动、SQLite）
4. 创建基础项目结构

### 阶段二：数据库连接模块
1. 实现本地SQLite存储配置
2. 实现数据库连接测试
3. 开发前端连接页面
4. 实现Wails绑定方法

### 阶段三：流程实例列表
1. 实现Activiti表查询（act_ru_execution、act_ru_task等）
2. 实现流程实例列表API
3. 开发前端列表页面
4. 实现分页和搜索

### 阶段四：变量管理
1. 实现变量查询（act_ru_variable）
2. 实现变量增删改
3. 开发前端变量编辑器
4. 处理不同类型变量

### 阶段五：流程控制
1. 研究Activiti表结构关系
2. 实现流程跳转逻辑
3. 实现流程回退逻辑
4. 开发前端操作界面

### 阶段六：流程定义编辑
1. 实现读取流程定义XML
2. 实现保存流程定义XML
3. 开发文本编辑器界面
4. XML语法高亮（可选）

### 阶段七：打包发布
1. 配置Wails编译选项
2. 编译Windows exe
3. 测试便携性
4. 优化体积（UPX压缩）

## 七、关键技术点

### 7.1 Wails绑定
```go
// main.go
type App struct {
    ctx context.Context
    db  *sql.DB
}

func (a *App) startup(ctx context.Context) {
    a.ctx = ctx
    // 初始化本地SQLite
}

// 绑定方法供JS调用
```

### 7.2 流程跳转实现（直接操作表）
```go
func (a *App) JumpToNode(instanceID, targetNodeID string) error {
    // 1. 查询当前执行流
    // 2. 更新act_ru_execution的act_id
    // 3. 删除当前act_ru_task
    // 4. 创建新的act_ru_task
    // 5. 插入历史记录
}
```

### 7.3 编译打包
```bash
# 安装依赖
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# 开发模式
wails dev

# 编译Windows版本
wails build -platform windows/amd64

# UPX压缩（减小体积）
upx --best --lzma build/activiti-tools.exe
```

## 八、项目文件清单

```
/workspace/
├── main.go
├── go.mod
├── go.sum
├── wails.json
├── frontend/
│   ├── index.html
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js
│       └── api.js
├── internal/
│   ├── database/
│   │   ├── sqlite.go      # 本地配置存储
│   │   ├── mysql.go       # MySQL操作
│   │   └── postgres.go    # PostgreSQL操作
│   ├── activiti/
│   │   ├── repository.go  # 流程定义
│   │   ├── runtime.go     # 流程实例
│   │   ├── task.go        # 任务
│   │   └── variable.go    # 变量
│   └── models/
│       └── models.go
└── build/
    └── activiti-tools.exe  # 最终输出
```

## 九、后续扩展方向
- 图形化流程图查看（集成bpmn-js）
- 流程定义版本管理
- 批量操作
- 操作日志记录
- 导出/导入流程定义
- 支持更多数据库（Oracle等）

