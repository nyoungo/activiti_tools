# 检查清单：用户信息关联显示功能

## 后端数据查询
- [ ] `getProcessInstances` 函数正确关联 `sys_user` 表
- [ ] `getProcessInstanceDetail` 函数正确关联 `sys_user` 表
- [ ] `getHistoryTasks` 函数正确关联 `sys_user` 表
- [ ] 所有关联查询都使用 LEFT JOIN 防止用户不存在时报错
- [ ] API 返回数据包含 `startUserName` 和 `startUserRealname` 字段
- [ ] API 返回数据包含 `assigneeName` 和 `assigneeRealname` 字段

## 前端显示
- [ ] 流程实例列表显示用户名或真实姓名
- [ ] 流程实例详情显示发起人详细信息
- [ ] 历史任务列表显示处理人详细信息
- [ ] 当用户不存在时能优雅处理（显示"未知用户"或用户ID）

## 功能验证
- [ ] 流程实例列表能正确显示用户名称
- [ ] 流程实例详情能正确显示发起人信息
- [ ] 历史任务能正确显示处理人信息
- [ ] 用户不存在时不会导致页面报错
