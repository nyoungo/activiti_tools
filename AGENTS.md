# 项目约定与踩坑记录

## 前端

- 中文文案和注释统一使用全角标点，与既有代码保持一致。
- 不修改 `node_modules`，也不修改任何第三方依赖，只改 `src/` 下的源码。

## bpmn-js 流程图

- 用 `display` 做布局的容器必须显式声明隐藏态：类选择器上的 `display` 会覆盖浏览器默认的 `[hidden]` 样式，导致 `element.hidden = true` 失效。本项目在 `.bpmn-pane` 和 `.bpmn-props` 上补写了 `[hidden]` 规则。
- 在隐藏容器里导入 XML 后画布尺寸为 0，切回可见面板时必须先调用 `canvas.resized()`，再执行 `zoom('fit-viewport')`，否则图形不可见。`setBpmnModeUI` 切到图形模式时已统一处理。
- Activiti 扩展属性需要注入 moddle 描述符：构造实例时传 `moddleExtensions`，描述符取 `src/public/vendor/bpmn-js/activiti.json`，来自 `activiti-bpmn-moddle@4.4.0`。不注入时 `assignee` 等属性会落进 `bo.$attrs`，属性面板无法按一级属性读写。
- `modeling.updateProperties` 传 `undefined` 可以移除属性，XML 里对应的属性或元素会被删掉，清空条件表达式同理。
- 读取元素类型用字符串形式，例如 `bo.$instanceOf('bpmn:UserTask')`，`bo.get(key)` 可以读取扩展属性。
- viewer 与 modeler 两个 UMD 包都会挂到 `window.BpmnJS`，加载后要立即缓存构造函数，避免互相覆盖。

## 无构建前端页面

- 第三方库以 UMD 方式加载，资源需 vendor 到 `src/public/vendor/` 下，不能依赖打包器解析 `import`。

## 弹层层级

- 实例详情弹窗 `z-index` 70，普通弹层 80，确认框 90，通知 120。
- 页面滚动锁统一由 `syncBodyLock` 按是否还有可见弹层来判断，不要在各弹层里单独增删 `body.modal-open`。
