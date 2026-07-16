# 更新日志

本文件记录 **TD-东哥 Image Compress Ultra** 的版本变更。  
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

仓库：https://github.com/webzol/INS

---

## [1.2.1] - 2026-07-16

### 修复
- **选图不弹层**：默认「最小触发」改为 **0KB**（全部拦截）；此前默认 100KB 会导致小图完全无反应
- 图片 MIME 为空时按**扩展名**识别（jpg/png/webp 等）
- `change` 监听同时挂在 `document` + `window`，并用 `composedPath` 兼容 Shadow DOM 内 file input
- content script 改为 `document_start` 注入，减少被站点抢先绑定导致拦不到的情况
- 浮层挂到 `documentElement` 固定层，降低被页面 CSS/`transform` 吃掉的概率
- 确认上传时额外派发 `input` 事件，兼容只监听 `input` 的站点

### 新增
- 设置项「调试日志」：控制台输出 `[TD-ImageCompress]` 便于排查
- 注入成功时打印 `content script ready`

---

## [1.2.0] - 2026-07-16

### 新增
- **拖拽上传拦截**：捕获阶段监听 `dragenter` / `dragover` / `drop`，拖入文件时显示全页蓝色提示遮罩
- **压缩前后缩略图**：每张图卡片展示「前 / 后」预览与体积对比
- **单张跳过**：可对指定图片保留原图，其余照常压缩；压缩后仍可切换并刷新合计
- **扩展图标**：`icons/icon{16,32,48,128}.png`，并配置到工具栏与扩展管理页

### 变更
- 浮层宽度与布局适配多图列表（可滚动）
- 提交拖拽结果时优先写回附近 `input[type=file]`，否则再派发带新文件的 `DragEvent`
- README / DEV_NOTES 补充 1.2.0 说明

### 说明
- 部分站点使用高度自定义 drop 逻辑时，拖拽注入可能失败，可改用点选上传

---

## [1.1.0] - 2026-07-16

### 新增
- **智能输出格式**（auto）：同一次绘制后比较 WebP / JPEG（透明源额外试 PNG），取更小结果
- **最大边长**设置（默认 1920px）：按最长边等比缩放，同时限制宽高
- **最小触发大小**（默认 100KB）：全部图片小于阈值则不拦截
- **输出格式**设置：智能 / WebP / JPEG
- 浮层支持 **Esc / ×** 关闭
- `DEV_NOTES.md` 开发笔记

### 变更
- 压缩后体积 ≥ 原图约 97% 时**保留原图**，避免无效转码
- 多选文件按原顺序 merge，非图片与 SVG 原样保留
- 解码优先 `createImageBitmap`，降低 FileReader DataURL 内存占用
- 压缩并发池限制为 2
- 清理 manifest 中无效的 `web_accessible_resources → ui.html`
- `content_scripts` 启用 `all_frames: true`（覆盖 iframe 内上传）

### 修复
- 旧版只限宽度导致竖图仍然过大
- 旧版确认上传只写回图片、丢掉同批非图片文件

---

## [1.0.0] - 2026-05-14

### 新增
- Manifest V3 扩展骨架
- 捕获阶段拦截 `input[type=file]` 的图片 `change`
- Shadow DOM 浮层：原图上传 / 开始压缩 / 确认上传
- Canvas 转 JPEG 压缩（默认质量 80%，宽度上限 1920）
- Popup 设置：自动检测开关、压缩质量
- `chrome.storage.sync` 跨标签同步配置

---

## 版本对照

| 版本 | 日期 | 摘要 |
|------|------|------|
| 1.2.1 | 2026-07-16 | 修复选图不拦截、注入时机与识别兜底 |
| 1.2.0 | 2026-07-16 | 拖拽、缩略图、单张跳过、图标 |
| 1.1.0 | 2026-07-16 | 智能格式、阈值/边长、多文件安全 |
| 1.0.0 | 2026-05-14 | 初版拦截 + JPEG 压缩 |

[1.2.1]: https://github.com/webzol/INS/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/webzol/INS/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/webzol/INS/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/webzol/INS/releases/tag/v1.0.0
