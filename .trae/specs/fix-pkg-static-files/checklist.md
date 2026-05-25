# 检查清单：修复 pkg 打包后静态文件服务问题

## 静态文件路径配置
- [x] `getPublicPath()` 函数正确处理 pkg 环境下的路径
- [x] 打包后的可执行文件能找到 `public` 文件夹
- [x] `express.static` 能正确加载静态文件

## pkg assets 配置
- [x] `package.json` 中的 assets 配置包含 `src/public/**/*`
- [x] 所有 CSS 文件被正确打包
- [x] 所有 JS 文件被正确打包
- [x] `index.html` 被正确打包

## 功能验证
- [ ] 打包后运行 exe 不报错
- [ ] 浏览器能自动打开 http://localhost:34567
- [ ] 访问根路径 `/` 返回 index.html
- [ ] CSS 文件 (style.css) 能正常加载
- [ ] JS 文件 (app.js) 能正常加载

## GitHub Actions
- [x] 工作流配置正确
- [ ] 打包命令能成功执行
- [ ] 构建产物包含所有必要的静态文件
