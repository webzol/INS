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

- 拖拽上传拦截
- 压缩前后缩略图预览
- 单张图单独跳过
- 统计累计节省体积
- 扩展图标 PNG 资源

## Git

- 远程：`https://github.com/webzol/INS.git`
- 忽略：`.trae/`（编辑器技能缓存）
