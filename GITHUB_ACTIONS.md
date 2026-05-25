# Activiti Tools - GitHub Action 打包说明

## 快速开始

### 1. 初始化 Git 仓库
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-username/activiti-tools.git
git push -u origin main
```

### 2. 创建 Tag 并发布
```bash
# 创建 tag
git tag -a v1.0.0 -m "Release version 1.0.0"

# 推送到 GitHub
git push origin v1.0.0
```

## GitHub Actions 配置说明

我们已创建了两个 Workflow：

### 1. 单一 Windows 打包 (推荐)
文件: `.github/workflows/build-release.yml`
- 仅打包 Windows 版本
- 触发方式：创建 `v*` 格式的 tag（如 v1.0.0）
- 支持手动触发：GitHub 仓库 → Actions → Build Windows Release → Run workflow

### 2. 多平台打包 (可选)
文件: `.github/workflows/build-multiplatform.yml`
- 同时打包 Windows/Linux/macOS
- 如需使用，可重命名为 `build-release.yml` 或手动触发

## 打包流程

1. **创建 Tag**
   ```bash
   git tag -a v1.0.0 -m "Version 1.0.0"
   git push origin v1.0.0
   ```

2. **等待 Action 执行**
   - 访问 GitHub 仓库的 Actions 页面查看进度
   - 执行完成后，Release 会自动创建

3. **下载 Release**
   - 访问仓库的 Releases 页面
   - 下载 `activiti-tools.exe`

## 本地打包

### Windows 平台
```bash
npm install
npm run build:win
```
生成文件位于 `build/activiti-tools.exe`

### 其他平台
```bash
npm install
npm run build:linux  # Linux
npm run build:mac    # macOS
```

## 文件说明

- `package.json` - 项目配置，包含 pkg 打包配置
- `.github/workflows/build-release.yml` - GitHub Action 配置
- `src/server.js` - 后端服务
- `src/public/` - 前端资源

## 注意事项

1. **版本号**
   - Tag 必须以 `v` 开头，如 `v1.0.0`、`v1.1.0-beta`
   
2. **pkg 配置**
   - `assets` 配置确保前端资源被打包进 exe
   - `compression: GZip` 减小文件体积
   
3. **本地测试**
   - 首次使用可先本地打包测试：`npm run build:win`
   - 执行生成的 exe 验证功能正常

4. **单文件运行**
   - 生成的 exe 无需 Node.js 环境，双击即可运行
   - 自动打开浏览器访问 http://localhost:34567
