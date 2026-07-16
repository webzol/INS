# DEV_NOTES — Image Compress Ultra

## 项目定位

浏览器扩展（Manifest V3）。在任意站点上传图片时，于 `change` **捕获阶段**拦截 `input[type=file]`，用 Canvas 本地压缩后再写回 `FileList`。

## 架构

| 文件 | 职责 |
|------|------|
| `content.js` | 事件拦截、压缩算法、Shadow DOM 浮层 |
| `popup.*` | `chrome.storage.sync` 设置读写 |
| `manifest.json` | MV3：`storage` + `content_scripts` all_urls |

无 background service worker；设置实时通过 `storage.onChanged` 同步到 content script。

## 关键决策（1.2.2）

1. **弹层定位**  
   host 不可用 `0×0`：Shadow 内 fixed 可能相对 host。改为全屏 fixed host（`pointer-events: none`）+ 面板 `position:absolute; top/right`（`pointer-events:auto`）。

## 关键决策（1.2.1）

1. **默认 minSizeKB=0**  
   1.1/1.2 默认 100KB 会导致大量「能选图但扩展完全没反应」，最常见误判。改为 0，小图也拦截。

2. **document_start + window/document 双监听 + composedPath**  
   部分站点在 document_idle 前就绑死 change；Shadow 内 input 的 event.target 不是 input。

3. **MIME 空扩展名兜底**  
   Windows 部分路径/相册选图 `file.type === ''`，仅靠 mime 会漏检。

4. **排查**  
   控制台应出现 `[TD-ImageCompress] content script ready`；开调试后有 input/drop 日志。

## 关键决策（1.2.0）

1. **拖拽拦截**  
   在捕获阶段监听 `dragenter/dragover/drop`。有 `Files` 时 `preventDefault` + 显示全页遮罩；`drop` 后走与 file input 同一套 UI。提交时优先把结果写回附近 `input[type=file]`，找不到则再派发 `DragEvent`（带新 DataTransfer）。  
   局限：部分站点用自定义 drop 且只读私有 state，可能无法 100% 注入；这类场景用户仍可用「点选上传」。

2. **缩略图**  
   原图 `URL.createObjectURL` 预览；压缩后同样生成 after URL。关闭/确认/跳过时统一 `revokeObjectURL` 防泄漏。

3. **单张跳过**  
   每张卡片独立 `skipped` 标记。压缩阶段跳过已标记图；确认上传时跳过的用原图，其余用压缩结果。可在压缩后仍切换跳过并刷新合计。

4. **图标**  
   `icons/icon{16,32,48,128}.png` 由 Pillow 生成（蓝底上传箭头 + 绿色压缩角标），写入 `icons` 与 `action.default_icon`。

## 关键决策（1.1.0）

1. **格式择优（auto）**  
   同一次绘制后生成 WebP + JPEG（透明源额外试 PNG），取最小且比原图至少小约 3% 才替换，否则保留原文件。避免「压完更大 / 白转格式」。

2. **透明**  
   PNG/WebP/GIF 源不铺白底；JPEG 候选仍会丢透明。智能模式会把 PNG 放进候选池。

3. **缩放**  
   以「最长边」限制（`maxEdge`），同时管宽高，修正旧版只限宽度导致竖图过大的问题。

4. **解码**  
   优先 `createImageBitmap(file)`，失败再 `blob:` + `Image`，避免 FileReader DataURL 占内存。

5. **多文件**  
   只压缩图片；`confirm` 时按原顺序 merge，非图片与 SVG 原样保留。旧版只塞压缩图，会丢掉同一次多选里的其他文件。

6. **并发**  
   压缩池并发 2，降低多图时 Canvas 内存峰值。

7. **阈值**  
   `minSizeKB`：全部图片都小于阈值则不拦截，减少对小图标/头像的打扰。

8. **manifest**  
   删除无效的 `web_accessible_resources → ui.html`（UI 全在 content Shadow DOM）；`all_frames: true` 覆盖 iframe 内上传控件。

## 易错点

- 写回 `input.files` 必须用 `DataTransfer`，并先设 `dataset.optimizerProcessed = 'true'`，再 `dispatchEvent(change)`，否则会再次拦截死循环。
- 必须在捕获阶段 `stopImmediatePropagation`，部分站点在冒泡阶段就读 files。
- 某些站点用自定义上传（非 file input / 直接 DnD），本扩展**拦不到**，需另做 drag-drop 拦截（未实现）。
- `canvas.toBlob('image/webp')` 在极老内核可能失败，代码已 fallback JPEG。
- 扩展更新后需在 `chrome://extensions` 点刷新，并**硬刷新页面**，旧 content script 不会自动替换。

## 本地加载

```
chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 E:\INS
```

改代码后：扩展页点刷新 → 目标页 Ctrl+F5。

## 未做 / 可后续

- 统计累计节省体积（跨站点 storage 计数）
- 拖拽在极端自定义上传组件上的兼容加固
- 压缩队列取消 / 暂停

## Git

- 远程：`https://github.com/webzol/INS.git`
- 忽略：`.trae/`（编辑器技能缓存）

## 版本记录

对外完整更新日志见 **[CHANGELOG.md](./CHANGELOG.md)**。

- 1.2.0 拖拽 + 缩略图 + 单张跳过 + icons
- 1.1.0 智能格式 / 阈值 / 边长 / 多文件 merge
- 1.0.0 初版
