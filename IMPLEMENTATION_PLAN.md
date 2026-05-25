# Activiti 6.0.0 工作流维护工具实现方案（便携版）

## 一、项目概述

### 1.1 项目目标
开发一个**便携小巧**的Activiti 6.0.0工作流维护工具，**双击即可在Windows上运行**，无需安装任何运行环境（JRE/Node.js等）。支持MySQL和PostgreSQL数据库连接，提供流程实例管理、节点编辑、流程跳转回退、变量管理等功能。

### 1.2 核心功能
- **数据库连接**：支持MySQL和PostgreSQL
- **流程实例列表**：展示当前运行的所有流程
- **流程图查看/编辑**：支持文本形式的流程定义编辑
- **节点管理**：节点信息查看与编辑
- **流程控制**：流程跳转、回退
- **变量管理**：流程变量和任务变量的查看与修改
- **便携性**：单exe文件，无外部依赖

## 二、技术选型（便携版）

### 2.1 技术栈
- **Go 1.21+**：后端语言，编译原生exe，无依赖
- **Wails v2**：Go + Web技术构建桌面应用
- **HTML5 + CSS3 + JavaScript (Vanilla JS)**：前端界面（无需框架，减小体积）
- **SQLite**：本地配置存储
- **MySQL Driver (github.com/go-sql-driver/mysql)**：MySQL驱动
- **PostgreSQL Driver (github.com/lib/pq)**：PostgreSQL驱动

### 2.2 为什么这个方案？
| 对比项 | Java/Spring Boot | Electron | Go + Wails |
|--------|------------------|----------|------------|
| 体积 | ~100MB+ (含JRE) | ~150MB+ | ~15-25MB |
| 启动速度 | 慢 | 中 | 快 |
| 依赖 | 需要JRE | 无需 | 无需 |
| 单文件 | 困难 | 是 | 是 |

### 2.3 项目结构
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

## 三、核心功能设计（Go版本）

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

