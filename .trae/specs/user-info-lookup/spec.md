# 用户信息关联显示功能

## 为什么
当前流程实例中显示的发起人只展示了用户 ID，不便于用户识别和操作。需要关联 `sys_user` 表获取用户的 `username` 和 `realname` 进行展示。

## 什么变更
- 修改流程实例查询逻辑，关联 `sys_user` 表获取用户详细信息
- 在 API 返回数据中添加 `startUserName` 和 `startUserRealname` 字段
- 更新前端显示逻辑，展示用户名称而不是用户 ID
- 保留历史任务的 `assignee` 字段也能关联显示用户名

## 影响
- 受影响的功能：流程实例列表、流程实例详情、历史任务列表
- 受影响的代码：
  - `src/server.js` - 修改数据库查询逻辑
  - `src/public/js/app.js` - 更新前端显示逻辑

## 新增需求
### 需求：用户信息关联查询
系统应能从 `sys_user` 表中查询用户的 `username` 和 `realname` 信息。

#### 场景：流程实例列表显示
- **当** 查询流程实例列表时
- **然后** 自动关联 `sys_user` 表获取用户信息
- **并且** 返回数据包含 `startUserId`、`startUserName`、`startUserRealname` 三个字段

#### 场景：流程实例详情显示
- **当** 查看流程实例详情时
- **然后** 同样关联 `sys_user` 表获取发起人信息
- **并且** 显示发起人的真实姓名而不是 ID

#### 场景：历史任务处理人显示
- **当** 查询历史任务列表时
- **然后** 关联 `sys_user` 表获取处理人信息
- **并且** 返回数据包含 `assigneeName` 和 `assigneeRealname` 字段

## 假设说明
- `sys_user` 表包含 `id`、`username`、`realname` 字段
- `ACT_RU_EXECUTION` 表的 `START_USER_ID_` 字段与 `sys_user.id` 对应
- `ACT_RU_TASK` 表的 `ASSIGNEE_` 字段与 `sys_user.id` 对应
- 数据库连接用户对 `sys_user` 表有读取权限
