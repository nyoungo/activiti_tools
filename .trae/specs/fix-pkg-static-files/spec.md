# 修复 pkg 打包后静态文件服务问题

## 为什么
当前应用在使用 `pkg` 打包后，运行 exe 文件时出现 "Cannot GET /" 错误，说明 `express.static` 无法正确找到和加载静态文件。问题出在 `getPublicPath()` 函数在 pkg 环境下的路径配置不正确。

## 什么变更
- 修复 `src/server.js` 中的 `getPublicPath()` 函数，使其在 pkg 打包后能正确定位到 `public` 文件夹
- 验证 `package.json` 中的 `pkg.assets` 配置是否正确包含所有静态文件
- 确保 `express.static` 能正确服务静态文件

## 影响
- 受影响的功能：应用启动后的 Web 界面访问
- 受影响的代码：
  - `src/server.js` - 静态文件路径配置
  - `package.json` - pkg 打包资源配置

## 新增需求
### 需求：pkg 打包后静态文件访问
打包后的可执行文件运行后，用户能够通过浏览器正常访问 Web 界面。

#### 场景：正常运行
- **当** 用户双击运行打包后的 exe 文件
- **然后** 浏览器自动打开 http://localhost:34567
- **并且** Web 界面正常显示，所有 CSS 和 JS 资源正确加载

#### 场景：静态文件访问
- **当** pkg 打包后运行 exe
- **然后** `express.static` 能正确定位 `public` 文件夹
- **并且** 访问根路径 `/` 返回 `index.html`
- **并且** 所有静态资源（CSS、JS、图片）都能正常加载

## 修改需求
### 需求：静态文件路径处理
`getPublicPath()` 函数在 pkg 环境下需要正确返回静态文件的绝对路径。

pkg 的 assets 会被打包进 snapshot 文件系统，需要使用正确的方法来定位这些文件：
1. 在 Windows 上：文件通常在 exe 同级目录的 `resources/app` 或 `snapshot` 目录
2. 路径需要能正确访问到 `public/index.html`
