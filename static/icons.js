/* ==========================================================================
   AA · 图标集（自绘内联 SVG）
   --------------------------------------------------------------------------
   为什么不用图标站（iconfont / Font Awesome / The Noun Project）：
   1. 它们要么依赖外部 CDN（国内时通时不通，加载失败 = 一排空白方块），
      要么需要下载整套字体文件（几百 KB）只为用几个图标。
   2. 内联 SVG 零外部依赖、可离线、随 currentColor 跟随主题变色、
      且能被 :focus 与 aria 正确关联。
   规格：24×24 视框 / 1.75 描边 / 圆头圆角，与 1.5px 细体界面比例协调。
   ========================================================================== */

const ICON_PATHS = {
  /* 今日提案：开口同心弧 + 核心 —— 呼应品牌图标的「触达通道」隐喻 */
  radar:
    '<path d="M19.5 12A7.5 7.5 0 1 1 12 4.5"/>' +
    '<path d="M16.5 12a4.5 4.5 0 1 1-4.5-4.5"/>' +
    '<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',

  /* 记忆库：层叠 */
  layers:
    '<path d="M12 4 3.5 8.5 12 13l8.5-4.5L12 4Z"/>' +
    '<path d="M3.5 13 12 17.5 20.5 13"/>',

  /* 触达历史：铃 */
  bell:
    '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z"/>' +
    '<path d="M13.7 19a2 2 0 0 1-3.4 0"/>',

  /* 设置：滑杆式（比齿轮更现代，且在小尺寸下不糊） */
  settings:
    '<path d="M20 7h-9"/><path d="M14 17H5"/>' +
    '<circle cx="17" cy="17" r="3"/><circle cx="8" cy="7" r="3"/>',

  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>' +
    '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',

  check: '<path d="M20 6 9 17l-5-5"/>',

  x: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',

  /* 锁定：永不衰减的记忆 */
  lock:
    '<rect x="3.5" y="10.5" width="17" height="10" rx="2.2"/>' +
    '<path d="M7.5 10.5V7a4.5 4.5 0 0 1 9 0v3.5"/>',

  /* 冷库：已归档待回收 */
  snowflake:
    '<path d="M12 3v18"/><path d="M4.2 7.5 19.8 16.5"/><path d="M19.8 7.5 4.2 16.5"/>',

  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',

  mail:
    '<rect x="3" y="5" width="18" height="14" rx="2.5"/>' +
    '<path d="m4 7.6 7.1 5a1.6 1.6 0 0 0 1.8 0l7.1-5"/>',

  shield:
    '<path d="M12 3 5 6v5.5c0 4.3 2.9 8.2 7 9.5 4.1-1.3 7-5.2 7-9.5V6l-7-3Z"/>',

  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',

  plus: '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',

  trash:
    '<path d="M4 7h16"/>' +
    '<path d="M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7"/>' +
    '<path d="m6.6 7 1 12.4A1.6 1.6 0 0 0 9.2 21h5.6a1.6 1.6 0 0 0 1.6-1.6L17.4 7"/>',

  refresh:
    '<path d="M3.5 12A8.5 8.5 0 0 1 18.1 6.1"/>' +
    '<path d="M18.5 3.5V7H15"/>' +
    '<path d="M20.5 12A8.5 8.5 0 0 1 5.9 17.9"/>' +
    '<path d="M5.5 20.5V17H9"/>',

  alert:
    '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.8v4.7"/>' +
    '<circle cx="12" cy="16.3" r=".75" fill="currentColor" stroke="none"/>',

  info:
    '<circle cx="12" cy="12" r="8.5"/><path d="M12 16.2v-4.7"/>' +
    '<circle cx="12" cy="7.8" r=".75" fill="currentColor" stroke="none"/>',

  user:
    '<circle cx="12" cy="8" r="3.6"/><path d="M4.6 20a7.4 7.4 0 0 1 14.8 0"/>',

  /* 提案火花 */
  sparkle:
    '<path d="M12 4l1.8 5.4L19 11l-5.2 1.6L12 18l-1.8-5.4L5 11l5.2-1.6L12 4Z"/>',

  archive:
    '<rect x="3" y="4.5" width="18" height="4.5" rx="1.6"/>' +
    '<path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/>' +
    '<path d="M10 13h4"/>',

  eye:
    '<path d="M2.5 12S6 5.6 12 5.6 21.5 12 21.5 12 18 18.4 12 18.4 2.5 12 2.5 12Z"/>' +
    '<circle cx="12" cy="12" r="3"/>',

  eyeOff:
    '<path d="M10.6 6.1a8.8 8.8 0 0 1 1.4-.1c6 0 9.5 6 9.5 6a17.6 17.6 0 0 1-2.6 3.4"/>' +
    '<path d="M6.3 7.9A17.4 17.4 0 0 0 2.5 12s3.5 6.4 9.5 6.4c1.9 0 3.5-.6 4.8-1.4"/>' +
    '<path d="m3 3 18 18"/>',

  /* 执行 / 动作 */
  zap: '<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z"/>',

  history:
    '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.5 4v4h4"/>' +
    '<path d="M12 8v4.3l3 1.8"/>',

  /* 静默：喇叭关闭 */
  bellOff:
    '<path d="M18 9a6 6 0 0 0-8.7-5.3"/><path d="M6.2 6.4A6 6 0 0 0 6 9c0 5-2 6.5-2 6.5h13"/>' +
    '<path d="M13.7 19a2 2 0 0 1-3.4 0"/><path d="m3 3 18 18"/>',

  /* 滑块微调：触达线 */
  sliders:
    '<path d="M4 6h7"/><path d="M15 6h5"/><circle cx="13" cy="6" r="2"/>' +
    '<path d="M4 18h5"/><path d="M13 18h7"/><circle cx="11" cy="18" r="2"/>',

  /* 对话：气泡 */
  chat:
    '<path d="M20.6 11.7c0 4.1-3.8 7.4-8.6 7.4-.9 0-1.8-.1-2.6-.35L4.4 21l1.2-3.7' +
    'A7.2 7.2 0 0 1 3.4 11.7C3.4 7.6 7.2 4.3 12 4.3s8.6 3.3 8.6 7.4Z"/>',

  /* 重命名：铅笔 */
  edit:
    '<path d="M17 3.2a2.8 2.8 0 0 1 4 4L7.6 20.6 2.5 22l1.4-5.1Z"/>' +
    '<path d="m15 5.2 3.9 3.9"/>',

  /* 开始 / 运行 */
  play: '<path d="M6.5 4.4v15.2L19 12Z"/>',

  /* 并行分支 */
  branch:
    '<path d="M6 3.2v11.6"/><circle cx="18" cy="6.2" r="2.8"/>' +
    '<circle cx="6" cy="18" r="2.8"/><path d="M18 9a9 9 0 0 1-9 9"/>',
};

/**
 * 生成一个内联 SVG 图标。
 *
 * 描边宽度会跟着尺寸走：24 视框下 1.75 的描边缩到 15px 只剩 1.1px，
 * 图标会细得像一道划痕（铅笔看着像斜杠、垃圾桶看着像空方框）。
 * 所以小尺寸自动加粗 —— 图标在视觉上「重量一致」比几何上一模一样更重要。
 *
 * @param {string} name  ICON_PATHS 中的键
 * @param {number} size  像素尺寸（默认 20）
 * @param {number} [sw]  描边宽度；不传则按尺寸自动取
 * @returns {string} SVG 字符串；名称不存在时返回空串（不抛异常，避免一个笔误炸掉整页）
 */
function icon(name, size = 20, sw) {
  const d = ICON_PATHS[name];
  if (!d) return '';
  if (sw == null) sw = size <= 14 ? 2.3 : size <= 18 ? 2.05 : 1.75;
  return (
    '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '"' +
    ' fill="none" stroke="currentColor" stroke-width="' + sw + '"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' +
    ' style="flex:0 0 auto">' + d + '</svg>'
  );
}

/* 供 Node 环境做单测（浏览器里这段会被忽略） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ICON_PATHS, icon };
}

/* build-bust */
