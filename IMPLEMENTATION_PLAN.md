# Activiti 6.0.0 工作流维护工具实现方案

## 一、项目概述

### 1.1 项目目标
开发一个Activiti 6.0.0工作流维护工具，支持MySQL和PostgreSQL数据库连接，提供流程实例管理、节点编辑、流程跳转回退、变量管理等功能。

### 1.2 核心功能
- **数据库连接**：支持MySQL和PostgreSQL
- **流程实例列表**：展示当前运行的所有流程
- **流程图查看/编辑**：支持文本形式的流程定义编辑
- **节点管理**：节点信息查看与编辑
- **流程控制**：流程跳转、回退
- **变量管理**：流程变量和任务变量的查看与修改

## 二、技术选型

### 2.1 后端技术栈
- **Java 8+**：Activiti 6.0.0主要支持Java 8+
- **Spring Boot 2.x**：快速开发框架
- **Activiti 6.0.0**：工作流引擎核心
- **MyBatis-Plus**：数据库操作
- **MySQL Connector/J / PostgreSQL Driver**：数据库驱动

### 2.2 前端技术栈
- **Vue 3**：前端框架
- **Element Plus**：UI组件库
- **Axios**：HTTP客户端

### 2.3 项目结构
```
/workspace/
├── backend/              # 后端项目
│   ├── src/
│   │   ├── main/
│   │   │   ├── java/
│   │   │   │   └── com/activiti/tools/
│   │   │   │       ├── config/        # 配置类
│   │   │   │       ├── controller/    # 控制器
│   │   │   │       ├── service/       # 业务逻辑
│   │   │   │       ├── dto/           # 数据传输对象
│   │   │   │       └── util/          # 工具类
│   │   │   └── resources/
│   │   │       ├── application.yml
│   │   │       └── mapper/
│   │   └── test/
│   └── pom.xml
├── frontend/             # 前端项目
│   ├── src/
│   │   ├── api/          # API接口
│   │   ├── components/   # 组件
│   │   ├── views/        # 页面
│   │   ├── store/        # 状态管理
│   │   └── main.js
│   └── package.json
└── README.md
```

## 三、核心功能设计

### 3.1 数据库连接模块

#### 3.1.1 功能描述
支持动态连接MySQL和PostgreSQL数据库，提供连接配置界面。

#### 3.1.2 接口设计
```java
// 数据库连接配置
public class DatabaseConfig {
    private String dbType;      // mysql 或 postgresql
    private String url;
    private String username;
    private String password;
}

// 连接测试接口
POST /api/database/connect
```

#### 3.1.3 实现要点
- 动态切换数据源
- 连接池管理
- 连接有效性验证

### 3.2 流程实例列表模块

#### 3.2.1 功能描述
展示当前正在运行的所有流程实例，支持分页和搜索。

#### 3.2.2 数据模型
```java
public class ProcessInstanceVO {
    private String id;
    private String processDefinitionId;
    private String processDefinitionName;
    private Date startTime;
    private String startUserId;
    private String businessKey;
    private List<TaskVO> currentTasks;
}
```

#### 3.2.3 接口设计
```java
// 获取流程实例列表
GET /api/process/instances?page=1&size=10&keyword=xxx

// 获取流程实例详情
GET /api/process/instances/{instanceId}
```

### 3.3 流程定义编辑模块

#### 3.3.1 功能描述
- 展示流程定义XML
- 支持文本形式编辑流程定义
- 保存并部署修改后的流程定义

#### 3.3.2 接口设计
```java
// 获取流程定义XML
GET /api/process/definitions/{definitionId}/xml

// 更新流程定义
PUT /api/process/definitions/{definitionId}/xml
```

### 3.4 节点管理模块

#### 3.4.1 功能描述
- 查看流程节点信息
- 编辑节点属性（名称、处理人等）

#### 3.4.2 数据模型
```java
public class NodeVO {
    private String id;
    private String name;
    private String type;  // userTask, serviceTask, gateway等
    private Map<String, Object> properties;
}
```

### 3.5 流程控制模块

#### 3.5.1 功能描述
- 流程跳转：将当前任务跳转到指定节点
- 流程回退：将流程回退到指定历史节点

#### 3.5.2 实现方案
- 使用Activiti的RuntimeService和HistoryService
- 自定义Command实现复杂的流程跳转逻辑
- 处理流程变量和任务变量

#### 3.5.3 接口设计
```java
// 流程跳转
POST /api/process/instances/{instanceId}/jump
{
    "targetNodeId": "xxx",
    "variables": {}
}

// 流程回退
POST /api/process/instances/{instanceId}/rollback
{
    "targetHistoryTaskId": "xxx"
}
```

### 3.6 变量管理模块

#### 3.6.1 功能描述
- 查看流程变量和任务变量
- 添加、修改变量
- 删除变量

#### 3.6.2 接口设计
```java
// 获取流程变量
GET /api/process/instances/{instanceId}/variables

// 设置流程变量
POST /api/process/instances/{instanceId}/variables

// 删除流程变量
DELETE /api/process/instances/{instanceId}/variables/{variableName}
```

## 四、Activiti 核心服务使用

### 4.1 关键服务
- `RepositoryService`：流程定义管理
- `RuntimeService`：流程实例运行时管理
- `TaskService`：任务管理
- `HistoryService`：历史数据查询
- `ManagementService`：引擎管理

### 4.2 动态数据源配置
```java
@Configuration
public class ActivitiConfig {
    
    @Bean
    public DataSource dynamicDataSource(DatabaseConfig config) {
        // 根据配置动态创建数据源
    }
    
    @Bean
    public ProcessEngine processEngine(DataSource dataSource) {
        // 配置ProcessEngine
    }
}
```

## 五、前端页面设计

### 5.1 页面结构
1. **数据库连接页**：连接配置表单
2. **流程实例列表页**：表格展示，支持搜索
3. **流程详情页**：
   - 流程图展示（使用BPMN.js或文本）
   - 节点信息
   - 变量管理
   - 流程控制操作

### 5.2 关键组件
- 数据库连接表单
- 流程实例表格
- 流程定义编辑器（文本编辑器）
- 变量编辑器
- 节点选择器（用于跳转/回退）

## 六、实施步骤

### 阶段一：项目初始化
1. 创建Spring Boot后端项目
2. 创建Vue 3前端项目
3. 配置基本依赖

### 阶段二：数据库连接模块
1. 实现动态数据源配置
2. 实现连接测试接口
3. 开发连接配置页面

### 阶段三：流程实例列表
1. 实现流程实例查询接口
2. 开发列表页面
3. 实现分页和搜索

### 阶段四：流程详情与变量管理
1. 实现流程实例详情接口
2. 实现变量CRUD接口
3. 开发详情页面

### 阶段五：流程控制
1. 实现流程跳转Command
2. 实现流程回退Command
3. 开发相关接口和页面

### 阶段六：流程定义编辑
1. 实现流程定义XML读取接口
2. 实现流程定义更新接口
3. 开发编辑器页面

## 七、关键技术点

### 7.1 流程跳转实现
```java
public class JumpTaskCmd implements Command<Void> {
    private String taskId;
    private String targetNodeId;
    private Map<String, Object> variables;
    
    @Override
    public Void execute(CommandContext commandContext) {
        // 实现跳转逻辑
    }
}
```

### 7.2 流程回退实现
```java
public class RollbackTaskCmd implements Command<Void> {
    private String taskId;
    private String targetHistoryTaskId;
    
    @Override
    public Void execute(CommandContext commandContext) {
        // 实现回退逻辑
    }
}
```

## 八、后续扩展方向
- 图形化流程图编辑（集成BPMN.js）
- 流程定义版本管理
- 批量操作
- 操作日志记录
- 用户权限管理
