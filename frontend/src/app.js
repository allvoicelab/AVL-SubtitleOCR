function startupUiLanguage() {
  try {
    return window.subtitleApp?.getUiLanguage?.() === "en" ? "en" : "zh-CN";
  } catch (_) {
    return "zh-CN";
  }
}
const INSTALLER_UI_LANGUAGE = startupUiLanguage();

// 三套重点色，工作区使用中性背景。
const PALETTES = [
  { id: "neon", get name() { return t("蓝色"); }, accent: "#3b82f6" },
  { id: "sage", get name() { return t("绿色"); }, accent: "#82b89c" },
  { id: "graphite", get name() { return t("橙色"); }, accent: "#ef6c35" }
];

// AllVoiceLab（趣丸千音）品牌链接，后续可按需替换为正式地址
const BRAND = {
  homepage: "https://www.allvoicelab.cn/?utm_source=avl_subtitle_ocr&utm_medium=desktop_app&utm_campaign=avl_subtitleocr",
  github: "https://github.com/allvoicelab/AVL-SubtitleOCR",
  // 指南链接先按 main 分支的文档路径约定生成。
  guideBranch: "main",
  business: "https://www.allvoicelab.cn/contact?source=home_page_direct&utm_source=avl_subtitle_ocr&utm_medium=desktop_app&utm_campaign=avl_subtitleocr"
};

// 后端状态 -> 界面文案与徽章样式。后端只会发这 7 种状态（SIDECAR_API.md 4.4）。
const STATUS_META = {
  idle: { get text() { return t("待处理"); }, badge: "ready" },
  waiting: { get text() { return t("排队中"); }, badge: "queued" },
  running: { get text() { return t("处理中"); }, badge: "processing" },
  completed: { get text() { return t("已完成"); }, badge: "done" },
  modified: { get text() { return t("已修改"); }, badge: "modified" },
  cancelled: { get text() { return t("已取消"); }, badge: "paused" },
  failed: { get text() { return t("失败"); }, badge: "failed" }
};

const SETTINGS_KEY = "subtitle-proofreader.settings";
const UI_KEY = "subtitle-proofreader.ui";
// 采样间隔默认值从 1 改成 2 时的一次性迁移标记：老存档里"没调过"的 1 要跟到新默认，
// 但用户之后真的选了 1 就不能再被抬走。
const FRAME_INTERVAL_MIGRATED_KEY = "subtitle-proofreader.frame-interval-migrated";
// 旧后端/浏览器预览没有 system.capabilities.cpuThreads 时的兜底范围。
const CPU_THREADS_FALLBACK = { min: 1, max: 8, default: 4 };
const THRESHOLD_FALLBACK = { min: 0.05, max: 0.95, default: 0.38 };
// 帧采样间隔只允许 1 与双数（1、2、4、6、8）；范围以后端 capabilities 为准，
// 这里只是握手前的兜底。
const FRAME_INTERVAL_FALLBACK = { min: 1, max: 8, default: 2 };
// 旧后端 / 浏览器预览没有 system.capabilities.device 时的兜底选项。
const DEVICE_FALLBACK = ["auto", "cpu", "gpu"];
const DEVICE_LABELS = {
  get auto() { return t("自动"); },
  cpu: "CPU",
  get gpu() { return t("优先 GPU"); }
};
// 语言中文名走后端能力表；握手前先用这两个兜底。
const LANGUAGE_LABEL_FALLBACK = { get ch() { return t("中文（简体）"); }, get en() { return t("英文"); } };
let languageLabels = { ...LANGUAGE_LABEL_FALLBACK };

let deviceOptions = [...DEVICE_FALLBACK];

function normalizeDeviceChoice(value) {
  const text = String(value || "").trim().toLowerCase();
  return deviceOptions.includes(text) ? text : "auto";
}

function languageLabel(code) {
  return t(UI_LANGUAGE_NAMES[code] || languageLabels[code] || code);
}

function syncUiLanguageButtons() {
  document.querySelectorAll("[data-ui-language]").forEach(button => {
    const selected = button.dataset.uiLanguage === uiI18n.language;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function setUiLanguage(language, notify = true) {
  state.settings.uiLanguage = language === "en" ? "en" : "zh-CN";
  uiI18n.setLanguage(state.settings.uiLanguage);
  persistSettings();
  window.subtitleApp?.setUiLanguage?.(state.settings.uiLanguage);
  uiI18n.apply();
  syncUiLanguageButtons();
  $("#currentFileName").textContent = getCurrentFile()?.name || t("尚未选择视频");
  renderPalettePicker();
  setPalette(state.palette);
  syncUiScaleForm();
  applyWindowMaximized(document.body.classList.contains("window-maximized"));
  $("#themeToggleButton").title = state.theme === "dark" ? t("切换浅色") : t("切换深色");
  $("#collapseSidebarButton").title = state.sidebarCollapsed ? t("展开侧边栏") : t("收起侧边栏");
  if (state.backend.capabilities) applyCapabilities(state.backend.capabilities);
  else $("#languageSelect").querySelectorAll("option").forEach(option => { option.textContent = languageLabel(option.value); });
  updateOcrLabel();
  updateVideoPickLabel();
  renderPendingList();
  const fileScroll = fileList.scrollTop;
  const subtitleScroll = subtitleList.scrollTop;
  renderFiles();
  renderSubtitles();
  fileList.scrollTop = fileScroll;
  subtitleList.scrollTop = subtitleScroll;
  updateSubtitleOverlay();
  for (const id of ["loadingTitle", "loadingDetail", "loadingSub", "errorTitle", "errorHint", "errorLogPath", "previewNoticeTitle", "previewNoticeText", "stillTime"]) {
    const element = document.getElementById(id);
    if (element) element.textContent = uiI18n.message(element.textContent);
  }
  if (lastDisplayedError) updateErrorLabels(lastDisplayedError);
  setExportBusy(exportInFlight, Boolean(exportInFlight));
  if (notify) showToast(t("语言选择已保存"));
}

// Keep the OCR language codes independent of the application's display language.
const UI_LANGUAGE_NAMES = Object.fromEntries([...document.querySelectorAll("#languageSelect option")]
  .map(option => [option.value, option.dataset.i18n || option.textContent]));

function defaultSettings() {
  return {
    uiLanguage: INSTALLER_UI_LANGUAGE,
    language: "ch",
    // 识别阈值按语言各记一份（旧 Qt 版行为），切语言不会互相覆盖。
    thresholds: { ch: 0.38, en: 0.38 },
    frameInterval: 2,
    detWorkers: 1,
    // null = 跟随后端下发的默认值（后端是 cpu//2），存储里也保持"未指定"。
    cpuThreads: null,
    // 推理设备：auto = 有 DirectML / CUDA 就用 GPU，否则 CPU；结果不受影响，
    // 所以换设备不会让"已完成"的任务变成需要重跑。
    device: "auto",
    outputDir: "",
    // 关掉后编辑只留在内存里，等切视频 / 导出 / 关窗口时再写盘。
    autoSave: true,
    followPlayback: true,
    nativeControls: false,
    // 打开软件先弹品牌介绍窗（设置里可关）。
    showIntroOnStartup: true
  };
}

const state = {
  theme: "light",
  palette: "neon",
  files: [],
  pendingVideos: [],
  pendingIds: [],
  currentFileId: null,
  ocrMode: "auto",
  running: false,
  progress: 0,
  timer: null,
  selectedFileIds: new Set(),
  // 新建任务弹窗那张"已选视频"列表里勾了哪些（只影响这张列表的批量移除）。
  setupSelectedIds: new Set(),
  uiScale: "standard",
  sidebarCollapsed: false,
  activeSubtitleId: null,
  currentView: "proofread",
  settings: defaultSettings(),
  // 后端（sidecar）状态；连不上时界面只读，不假装能识别。
  backend: {
    ready: false,
    everReady: false,
    error: "",
    hello: null,
    capabilities: null,
    wired: false,
    // 冷启动 / 重连中：这时点"开始识别"要排队等后端，而不是直接报错。
    connecting: false,
    bootstrapping: null,
    // 看门狗按 E_OCR_STALLED 收过尾：后端会自己退出再由主进程重连，
    // 重连成功后要告诉用户"为什么得重跑"，而不是只留一行小字。
    stalled: null
  },
  queue: { runningId: null, total: 0, index: 0, failures: 0 },
  // 每一轮"开始识别"领一个号；等后端期间用户点了停止就把号往前推，
  // 这一轮自己作废，不会在后端起来之后偷偷开跑。
  runToken: 0,
  preview: { jobId: null, targetId: null, message: "" },
  pushTimer: null,
  pushTargetId: null,
  renderQueued: false,
  // 时间轴：缩放（px/s）与折叠状态都是纯界面偏好，跟着 UI_KEY 一起存。
  timeline: { pps: 10, collapsed: false, autoCollapsed: false },
  // 校对页画面/字幕列表的宽度比例（拖分隔条改），纯界面偏好，跟 UI_KEY 一起存。
  proofreadSplit: 0.5,
  // 方案 C：上次停在校对页的位置（视图 / 当前视频 / 播放头 / 选中的字幕）。
  // 只读、best-effort 恢复（SESSION_RESTORE_DESIGN.md §4）。任务 id 每次启动都会
  // 重新生成，所以"当前视频"按视频路径记。
  uiRestore: {
    view: null,
    currentFilePath: null,
    playbackMs: null,
    activeSubtitleId: null,
    viewApplied: false,
    positionApplied: false
  }
};

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// system.capabilities 的 {min,max,default} 由后端下发，缺失时回落到兜底值。
function capabilityBounds(entry, fallback) {
  const source = entry && typeof entry === "object" ? entry : {};
  const pick = (value, instead) => (value == null || !Number.isFinite(Number(value))
    ? instead
    : Number(value));
  return {
    min: pick(source.min, fallback.min),
    max: pick(source.max, fallback.max),
    default: pick(source.default, fallback.default)
  };
}

function clampCpuThreads(value, bounds) {
  if (value == null || String(value).trim() === "") return Math.round(bounds.default);
  return Math.round(clampNumber(value, bounds.min, bounds.max, bounds.default));
}

function cpuThreadBounds() {
  return capabilityBounds(state.backend.capabilities?.cpuThreads, CPU_THREADS_FALLBACK);
}

function thresholdBounds() {
  return capabilityBounds(state.backend.capabilities?.threshold, THRESHOLD_FALLBACK);
}

function frameIntervalBounds() {
  return capabilityBounds(state.backend.capabilities?.frameInterval, FRAME_INTERVAL_FALLBACK);
}

// 允许的取值阶梯：下限（1）+ 其后的所有双数。
function frameIntervalLadder(bounds) {
  const min = Math.max(1, Math.round(bounds.min));
  const max = Math.max(min, Math.round(bounds.max));
  const ladder = [];
  for (let value = min; value <= max; value += 1) {
    if (value === min || value % 2 === 0) ladder.push(value);
  }
  return ladder;
}

// 把任意来源的值（键入、上下键、滚轮、微调按钮、粘贴）吸附到阶梯上：看得出
// 变化方向时按方向取相邻值（2 上 → 4，4 下 → 2），看不出方向才取最近值。
function normalizeFrameInterval(value, previous, bounds) {
  const ladder = frameIntervalLadder(bounds);
  const last = ladder[ladder.length - 1];
  const nearest = (raw) => ladder.reduce(
    (best, item) => (Math.abs(item - raw) < Math.abs(best - raw) ? item : best), ladder[0]);
  const text = String(value == null ? "" : value).trim();
  const raw = Number(text);
  if (text === "" || !Number.isFinite(raw)) {
    return ladder.includes(bounds.default) ? bounds.default : nearest(bounds.default);
  }
  if (ladder.includes(raw)) return raw;
  const before = Number(previous);
  if (Number.isFinite(before) && ladder.includes(before)) {
    if (raw > before) return ladder.find((item) => item >= raw) ?? last;
    if (raw < before) return [...ladder].reverse().find((item) => item <= raw) ?? ladder[0];
  }
  return nearest(raw);
}

// 沿阶梯上/下走一格（上下键用），并立刻写回设置。以输入框里的当前值为准：
// 键入之后还没失焦时，state 里还是上一个已提交的值。
function stepFrameInterval(direction) {
  const bounds = frameIntervalBounds();
  const ladder = frameIntervalLadder(bounds);
  const index = ladder.indexOf(
    normalizeFrameInterval($("#sampleGapInput").value, null, bounds));
  const next = ladder[Math.min(ladder.length - 1, Math.max(0, index + direction))];
  $("#sampleGapInput").value = String(next);
  readSettingsFromForm();
}

// 当前语言记得的识别阈值（没记过就用后端默认值）。
function currentThreshold() {
  const bounds = thresholdBounds();
  const stored = (state.settings.thresholds || {})[state.settings.language];
  return clampNumber(stored, bounds.min, bounds.max, bounds.default);
}

function storeThreshold(language, value) {
  const bounds = thresholdBounds();
  state.settings.thresholds = {
    ...state.settings.thresholds,
    [language]: clampNumber(value, bounds.min, bounds.max, bounds.default)
  };
}

// 和本机默认值一样就存 null（= 继续跟设备自适应），只有确实调过才固定下来。
function pinCpuThreads(value, bounds) {
  const chosen = clampCpuThreads(value, bounds);
  return chosen === Math.round(bounds.default) ? null : chosen;
}

function loadStoredSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (saved && typeof saved === "object") {
      state.settings = { ...defaultSettings(), ...saved };
      if (state.settings.uiLanguage !== "en" && state.settings.uiLanguage !== "zh-CN") {
        state.settings.uiLanguage = INSTALLER_UI_LANGUAGE;
      }
      const stored = state.settings.thresholds;
      if (stored && typeof stored === "object") {
        state.settings.thresholds = { ...defaultSettings().thresholds, ...stored };
      } else {
        // 旧版本只存一个 threshold：两种语言都从它起步。
        const legacy = Number(saved.threshold);
        state.settings.thresholds = Number.isFinite(legacy)
          ? { ch: legacy, en: legacy }
          : defaultSettings().thresholds;
      }
      delete state.settings.threshold;
      // 采样间隔的旧默认值是 1：老存档里如果还是 1，按"没调过"处理跟到新默认。
      if (Number(saved.frameInterval) === 1
          && !localStorage.getItem(FRAME_INTERVAL_MIGRATED_KEY)) {
        state.settings.frameInterval = defaultSettings().frameInterval;
        persistSettings();
      }
    }
  } catch (error) {
    /* 存储损坏时回落到默认值 */
  }
  try {
    localStorage.setItem(FRAME_INTERVAL_MIGRATED_KEY, "1");
  } catch (error) {
    /* 存不下就下次启动再迁一次，不影响使用 */
  }
  try {
    const ui = JSON.parse(localStorage.getItem(UI_KEY) || "null");
    if (ui && typeof ui === "object") {
      if (ui.theme) state.theme = ui.theme;
      if (ui.palette) state.palette = ui.palette;
      if (ui.uiScale) state.uiScale = ui.uiScale;
      if (typeof ui.sidebarCollapsed === "boolean") state.sidebarCollapsed = ui.sidebarCollapsed;
      if (ui.timeline && typeof ui.timeline === "object") {
        if (Number(ui.timeline.pps) > 0) state.timeline.pps = Number(ui.timeline.pps);
        if (typeof ui.timeline.collapsed === "boolean") state.timeline.collapsed = ui.timeline.collapsed;
      }
      if (Number.isFinite(Number(ui.proofreadSplit))) {
        state.proofreadSplit = clampNumber(ui.proofreadSplit, PROOFREAD_SPLIT_MIN_RATIO,
          PROOFREAD_SPLIT_MAX_RATIO, PROOFREAD_SPLIT_DEFAULT);
      }
      // 方案 C：位置这几项（非法值一律忽略，别让坏存档把界面带到奇怪的地方）。
      if (ui.view === "files" || ui.view === "proofread") state.uiRestore.view = ui.view;
      if (typeof ui.currentFilePath === "string" && ui.currentFilePath.trim()) {
        state.uiRestore.currentFilePath = ui.currentFilePath.trim();
      }
      if (Number.isFinite(Number(ui.playbackMs)) && Number(ui.playbackMs) >= 0) {
        state.uiRestore.playbackMs = Number(ui.playbackMs);
      }
      if (Number.isFinite(Number(ui.activeSubtitleId))) {
        state.uiRestore.activeSubtitleId = Number(ui.activeSubtitleId);
      }
    }
  } catch (error) {
    /* 同上 */
  }
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch (error) {
    /* 隐私模式等场景下写不进去，不影响使用 */
  }
}

function persistUi() {
  try {
    const snapshot = {
      theme: state.theme,
      palette: state.palette,
      uiScale: state.uiScale,
      sidebarCollapsed: state.sidebarCollapsed,
      proofreadSplit: state.proofreadSplit,
      timeline: { pps: state.timeline.pps, collapsed: state.timeline.collapsed === true }
    };
    // 方案 C：位置这几项要等启动恢复做完（applyPendingUiView）再接手，否则初始化里的
    // setTheme / setUiScale 会拿默认值把上次的位置冲掉。
    if (state.uiRestore.viewApplied) {
      snapshot.view = state.currentView;
      snapshot.currentFilePath = currentFilePathForUi();
      snapshot.playbackMs = currentPlaybackMsForUi();
      snapshot.activeSubtitleId = Number.isFinite(Number(state.activeSubtitleId))
        ? Number(state.activeSubtitleId)
        : null;
    }
    localStorage.setItem(UI_KEY, JSON.stringify(snapshot));
  } catch (error) {
    /* 同上 */
  }
}

// ------------------------------------------------------- 会话恢复（方案 C）
// 校对页位置：上次的视图、当前视频、播放头、选中的那条字幕。只读 best-effort，
// 任何一项恢复失败就跳过（SESSION_RESTORE_DESIGN.md §4）。
// 任务 id 每次启动都会重新生成，所以"当前视频"按视频路径记。
function brandIntroOpen() {
  return Boolean(aboutModal) && !aboutModal.classList.contains("hidden");
}

function currentFilePathForUi() {
  const file = getCurrentFile();
  return file && file.path ? file.path : null;
}

function currentPlaybackMsForUi() {
  if (!videoPlayer.getAttribute("src")) return null;
  const seconds = Number(videoPlayer.currentTime);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

// 品牌介绍窗优先：它开着时先不切视图、不做 seek，关掉之后（closeBrandIntro）再 apply，
// 否则用户会看到视图在弹窗后面闪一下。
function applyPendingUiView() {
  const restore = state.uiRestore;
  if (restore.viewApplied) return;
  if (brandIntroOpen()) return;
  if (restore.view) showView(restore.view);
  restore.viewApplied = true;
}

function applyPendingUiPosition() {
  const restore = state.uiRestore;
  if (restore.positionApplied) return;
  if (brandIntroOpen()) return;
  if (!restore.currentFilePath) {
    restore.positionApplied = true;
    return;
  }
  // 任务列表还没读回来（快照读得慢）：等下一次触发，别把这一项丢掉。
  if (!sessionSnapshotLoaded && !state.files.length) return;
  restore.positionApplied = true;
  const wanted = restore.currentFilePath.toLowerCase();
  const file = state.files.find((item) => String(item.path || "").toLowerCase() === wanted);
  if (!file) return;   // 已经不在列表里：忽略这一项（列表会停在第一行）
  // 文件不在了的行有「重新选择」入口，别去探测它（会再弹一次读不出来的提示）。
  if (file.needsRelink) return;
  selectFile(file.id);
  const cues = file.cues || [];
  const cue = cues.find((item) => item.id === restore.activeSubtitleId);
  setActiveSubtitle(cue ? cue.id : (cues[0] ? cues[0].id : null));
  updateRowHighlight();
  updateSubtitleOverlay();
  if (Number.isFinite(restore.playbackMs)) applyRestoredPlayback(file, restore.playbackMs);
}

// 回到上次的播放头：位置先记在行上——冷启动时 src 往往还没设上（探测 / 预览都是
// 异步的），等真的能 seek 了再落这一次（loadVideoForFile / applyPreviewReady 会来叫）。
function applyRestoredPlayback(file, ms) {
  if (!file) return;
  file.pendingSeekMs = Math.max(0, Math.round(Number(ms) || 0));
  // 定格帧不依赖播放器：还没有可播的源时也能先把那一帧显示出来。
  if (!videoPlayer.getAttribute("src")) scheduleStillAt(file.pendingSeekMs);
  commitPendingSeek(file);
}

function commitPendingSeek(file) {
  if (!file || file.id !== state.currentFileId) return;
  // 注意别用 Number(null)：那是 0，会把"没有待定位"的行也 seek 到开头。
  const ms = file.pendingSeekMs;
  if (typeof ms !== "number" || !Number.isFinite(ms)) return;
  if (!videoPlayer.getAttribute("src")) return;
  if (Number(videoPlayer.readyState) < 1) {
    if (file.pendingSeekBound) return;
    file.pendingSeekBound = true;
    const onMetadata = () => {
      videoPlayer.removeEventListener("loadedmetadata", onMetadata);
      file.pendingSeekBound = false;
      commitPendingSeek(file);
    };
    videoPlayer.addEventListener("loadedmetadata", onMetadata);
    return;
  }
  file.pendingSeekMs = null;
  const total = videoDurationMs();
  // 超过片长的位置夹回开头（duration 还没探到时按原值）。
  const at = commitSeek(total > 0 && ms > total - 40 ? 0 : ms);
  if (typeof videoPlayer.pause === "function") videoPlayer.pause();
  updateSubtitleOverlay();
  scheduleStillAt(at);
}

function applySettingsToForm() {
  const settings = state.settings;
  $("#languageSelect").value = settings.language;
  const threshold = currentThreshold();
  $("#thresholdRange").value = String(threshold);
  $("#thresholdOutput").textContent = threshold.toFixed(2);
  // 老存档里可能存着上一版的奇数（如 3）：载入时先吸附再回填。
  settings.frameInterval = normalizeFrameInterval(
    settings.frameInterval, null, frameIntervalBounds());
  $("#sampleGapInput").value = String(settings.frameInterval);
  $("#cpuThreadsInput").value = String(clampCpuThreads(settings.cpuThreads, cpuThreadBounds()));
  $("#deviceSelect").value = normalizeDeviceChoice(settings.device);
  $("#outputDirInput").value = settings.outputDir || "";
  $("#autoSaveToggle").checked = settings.autoSave !== false;
  $("#followPlaybackToggle").checked = settings.followPlayback !== false;
  $("#nativeControlsToggle").checked = settings.nativeControls === true;
  $("#introOnStartupToggle").checked = settings.showIntroOnStartup !== false;
  syncUiScaleForm();
}

function readSettingsFromForm() {
  const language = $("#languageSelect").value || "ch";
  const bounds = thresholdBounds();
  state.settings = {
    uiLanguage: state.settings.uiLanguage === "en" ? "en" : "zh-CN",
    language,
    thresholds: {
      ...state.settings.thresholds,
      [language]: clampNumber($("#thresholdRange").value, bounds.min, bounds.max, bounds.default)
    },
    frameInterval: normalizeFrameInterval(
      $("#sampleGapInput").value, state.settings.frameInterval, frameIntervalBounds()),
    detWorkers: state.settings.detWorkers,
    cpuThreads: pinCpuThreads($("#cpuThreadsInput").value, cpuThreadBounds()),
    device: normalizeDeviceChoice($("#deviceSelect").value),
    outputDir: $("#outputDirInput").value.trim(),
    autoSave: state.settings.autoSave !== false,
    followPlayback: state.settings.followPlayback !== false,
    nativeControls: state.settings.nativeControls === true,
    showIntroOnStartup: state.settings.showIntroOnStartup !== false
  };
  // 吸附后的值写回输入框：键入 / 微调出来的奇数不会留在界面上。
  $("#sampleGapInput").value = String(state.settings.frameInterval);
  persistSettings();
  updateOcrLabel();
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const subtitleList = $("#subtitleList");
const fileList = $("#fileList");
const onboardingModal = $("#onboardingModal");
const aboutModal = $("#aboutModal");
const loadingModal = $("#loadingModal");
const errorModal = $("#errorModal");
const settingsModal = $("#settingsModal");
const videoPlayer = $("#videoPlayer");
const posterState = $("#posterState");
const videoFrame = $("#videoFrame");
const stillOverlay = $("#stillOverlay");
const stillImage = $("#stillImage");
const stillTime = $("#stillTime");
const stillCloseButton = $("#stillCloseButton");
const playerControls = $("#playerControls");
const playPauseButton = $("#playPauseButton");
const pcCurrentTime = $("#pcCurrentTime");
const pcDuration = $("#pcDuration");
const seekTrack = $("#seekTrack");
const seekBuffered = $("#seekBuffered");
const seekPlayed = $("#seekPlayed");
const seekThumb = $("#seekThumb");
const muteButton = $("#muteButton");
const volumeButton = $("#volumeButton");
const volumeControl = $("#volumeControl");
const volumePopover = $("#volumePopover");
const volumeValue = $("#volumeValue");
const volumeRange = $("#volumeRange");
const speedButton = $("#speedButton");
const progressCircle = $("#progressCircle");
const circumference = 2 * Math.PI * 56;
const timelinePanel = $("#timelinePanel");
const timelineScroll = $("#timelineScroll");
const timelineInner = $("#timelineInner");
const timelineRuler = $("#timelineRuler");
const timelineLane = $("#timelineLane");
const timelineBlocks = $("#timelineBlocks");
const timelinePlayhead = $("#timelinePlayhead");
const timelineZoomLabel = $("#timelineZoomLabel");
const timelineZoomInButton = $("#timelineZoomInButton");
const timelineZoomOutButton = $("#timelineZoomOutButton");
const timelineFitButton = $("#timelineFitButton");
const timelineCollapseButton = $("#timelineCollapseButton");
const proofreadGrid = $(".proofread-grid");
const proofreadSplitter = $("#proofreadSplitter");
const proofreadVideoPanel = $(".video-panel");
let timelineScrollRenderQueued = false;
// 品牌介绍弹窗「收进左上角图标」的动效序号：中途又被点开时用它作废旧的收尾。
let brandIntroEpoch = 0;
let brandIntroCollapsing = false;

function init() {
  progressCircle.style.strokeDasharray = `${circumference}`;
  progressCircle.style.strokeDashoffset = `${circumference}`;
  loadStoredSettings();
  state.settings.uiLanguage = state.settings.uiLanguage === "en" ? "en" : "zh-CN";
  uiI18n.setLanguage(state.settings.uiLanguage);
  uiI18n.apply();
  syncUiLanguageButtons();
  window.subtitleApp?.setUiLanguage?.(state.settings.uiLanguage);
  bindEvents();
  bindWindowMaximizeState();
  loadAppVersion();
  bindDropZone();
  bindTimeline();
  bindProofreadSplitter();
  setTheme(state.theme);
  setPalette(state.palette);
  setUiScale(["compact", "standard", "large"].indexOf(state.uiScale) >= 0
    ? ["compact", "standard", "large"].indexOf(state.uiScale)
    : 1);
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  syncTimelineViewport();
  applySettingsToForm();
  renderSubtitles();
  renderFiles();
  updateOcrLabel();
  updateSubtitleOverlay();
  showView("proofread");
  // 冷启动先给品牌介绍：选择视频交给侧边栏「新建任务」和「开始识别」。
  maybeShowBrandIntro();
  // 方案 C：回到上次的视图（品牌介绍窗开着时会被推迟到它关掉之后）。
  applyPendingUiView();
  // 会话恢复（方案 A）：先把上次的任务列表读回来（一个小文件，毫秒级）再连后端；
  // 读失败也照常启动，只是这次没有列表。
  loadSessionSnapshot().finally(() => bootstrapBackend());
}

function applyWindowMaximized(isMaximized) {
  document.body.classList.toggle("window-maximized", Boolean(isMaximized));
  const button = $("#maximizeWindowButton");
  const label = isMaximized ? t("还原") : t("最大化");
  button.title = label;
  button.setAttribute("aria-label", label);
}

function loadAppVersion() {
  if (!window.subtitleApp?.getVersion) return;
  Promise.resolve(window.subtitleApp.getVersion()).then((version) => {
    if (typeof version === "string" && version) $("#appVersion").textContent = `v${version}`;
  }).catch(() => {});
}

function bindWindowMaximizeState() {
  const api = window.subtitleApp;
  if (!api?.isMaximized) return;
  Promise.resolve(api.isMaximized()).then(applyWindowMaximized).catch(() => {});
  api.onWindowMaximizedChange?.(applyWindowMaximized);
}

function bindEvents() {
  $$('[data-ui-language]').forEach(button => {
    button.addEventListener("click", () => setUiLanguage(button.dataset.uiLanguage));
  });
  $("#minimizeWindowButton").addEventListener("click", () => window.subtitleApp?.minimizeWindow());
  $("#maximizeWindowButton").addEventListener("click", () => window.subtitleApp?.toggleMaximizeWindow());
  $("#closeWindowButton").addEventListener("click", () => window.subtitleApp?.closeWindow());
  $(".window-caption").addEventListener("dblclick", () => window.subtitleApp?.toggleMaximizeWindow());

  $("#themeToggleButton").addEventListener("click", toggleTheme);
  $("#collapseSidebarButton").addEventListener("click", toggleSidebar);
  $("#settingsLightButton").addEventListener("click", () => setTheme("light"));
  $("#settingsDarkButton").addEventListener("click", () => setTheme("dark"));
  renderPalettePicker();
  $("#uiScaleRange").addEventListener("input", (event) => setUiScale(Number(event.target.value)));

  $("#newTaskButton").addEventListener("click", showSetup);
  $("#proofreadNavButton").addEventListener("click", () => showView("proofread"));
  $("#fileManagerButton").addEventListener("click", () => showView("files"));
  $("#settingsButton").addEventListener("click", () => {
    syncUiScaleForm();
    show(settingsModal);
  });
  $("#closeSettingsButton").addEventListener("click", () => hide(settingsModal));
  $("#saveSettingsButton").addEventListener("click", saveSettings);
  $("#resetSettingsButton").addEventListener("click", resetSettings);

  $("#closeSetupButton").addEventListener("click", hideSetup);
  $("#chooseVideosButton").addEventListener("click", chooseVideos);
  $("#pendingAddButton").addEventListener("click", chooseVideos);
  $("#pendingSelectAllButton").addEventListener("click", toggleSelectAllPending);
  $("#pendingRemoveButton").addEventListener("click", removeSelectedPending);
  $("#pendingList").addEventListener("change", onPendingListChange);
  $("#pendingList").addEventListener("click", onPendingListClick);
  $("#browserVideoInput").addEventListener("change", handleBrowserVideos);
  $("#chooseDirButton").addEventListener("click", chooseDirectory);
  // 折叠按钮在 label 里，不拦一下会顺带把"专家模式"复选框也切了。
  $("#expertCollapseButton").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    $(".expert-box").classList.toggle("collapsed");
  });
  $("#expertToggle").addEventListener("change", (event) => {
    $(".expert-box").classList.toggle("collapsed", !event.target.checked);
  });
  $("#thresholdRange").addEventListener("input", (event) => {
    $("#thresholdOutput").textContent = Number(event.target.value).toFixed(2);
  });
  $("#thresholdRange").addEventListener("change", readSettingsFromForm);

  $("#languageSelect").addEventListener("change", () => {
    // 先把滑杆的值记回切换前的语言，再载入新语言的记忆值（同旧 Qt 版）。
    storeThreshold(state.settings.language, $("#thresholdRange").value);
    state.settings.language = $("#languageSelect").value || "ch";
    applySettingsToForm();
    persistSettings();
    updateOcrLabel();
  });
  // 帧采样间隔只有 1 与双数：上下键走阶梯（原生一次只加 1，会停在奇数上），
  // 键入 / 微调 / 滚轮出来的奇数交给 change 里的吸附。
  $("#sampleGapInput").addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    stepFrameInterval(event.key === "ArrowUp" ? 1 : -1);
  });
  $("#sampleGapInput").addEventListener("input", (event) => {
    const text = String(event.target.value == null ? "" : event.target.value).trim();
    // 空值（正在重新输入）与合法值都不动，免得和键入打架。
    if (text === "" || Number(text) % 2 === 0) return;
    event.target.value = String(normalizeFrameInterval(
      text, state.settings.frameInterval, frameIntervalBounds()));
  });
  $("#sampleGapInput").addEventListener("change", readSettingsFromForm);
  $("#cpuThreadsInput").addEventListener("change", readSettingsFromForm);
  $("#deviceSelect").addEventListener("change", readSettingsFromForm);
  $("#outputDirInput").addEventListener("change", readSettingsFromForm);
  // 自动保存：关掉后编辑只留在内存里（行里会标"改动未保存"），
  // 切视频 / 导出 / 关窗口这几个时机才写盘。
  $("#autoSaveToggle").addEventListener("change", (event) => {
    state.settings.autoSave = Boolean(event.target.checked);
    persistSettings();
    if (state.settings.autoSave) {
      showToast(t("已开启自动保存"));
      flushPendingCues();
    } else {
      showToast(t("已关闭自动保存：改动会在切视频 / 导出 / 关窗口时一起保存"));
    }
  });
  // 跟随播放：播放时自动高亮并滚动到当前字幕（设置面板里的开关，之前没接线）。
  $("#followPlaybackToggle").addEventListener("change", (event) => {
    state.settings.followPlayback = Boolean(event.target.checked);
    persistSettings();
  });
  // 原生控件条只当回退用：这个模式下不显示画面内定格帧（会挡住原生进度条）。
  $("#nativeControlsToggle").addEventListener("change", (event) => {
    state.settings.nativeControls = Boolean(event.target.checked);
    persistSettings();
    if (state.settings.nativeControls) hideStill();
    updatePlayerControls();
  });
  // 启动介绍窗：默认开，关掉后冷启动不再弹，仍可点左上角图标看。
  $("#introOnStartupToggle").addEventListener("change", (event) => {
    state.settings.showIntroOnStartup = Boolean(event.target.checked);
    persistSettings();
  });

  $("#startRecognizeButton").addEventListener("click", startRecognition);
  $("#batchStopButton").addEventListener("click", stopBatch);
  $("#openInPlayerButton").addEventListener("click", openCurrentInPlayer);
  $("#previewPrepareButton").addEventListener("click", () => {
    const file = getCurrentFile();
    if (!file) return;
    hidePreviewNotice();
    preparePreviewFor(file, true);
  });
  $("#cancelRunButton").addEventListener("click", cancelRecognition);
  // 点弹窗外的遮罩就收起来：识别照常在后台跑，用户能回主界面继续操作。
  // updateLoadingModal 见到 hidden 直接 return，所以收起后不会被下一条进度事件顶回来。
  loadingModal.addEventListener("click", (event) => {
    if (event.target !== loadingModal) return;
    hide(loadingModal);
    showToast(t("识别在后台继续，进度见文件列表"));
  });
  $("#closeErrorButton").addEventListener("click", () => hide(errorModal));
  $("#retryErrorButton").addEventListener("click", () => {
    hide(errorModal);
    reconnectBackend();
  });
  $("#copyErrorButton").addEventListener("click", copyError);
  $("#feedbackButton").addEventListener("click", revealErrorLog);

  $("#addSubtitleButton").addEventListener("click", addSubtitle);
  $("#searchInput").addEventListener("input", renderSubtitles);
  $("#fileSearchInput").addEventListener("input", renderFiles);
  $("#selectAllFilesCheckbox").addEventListener("change", toggleSelectAllFiles);
  $("#batchDeleteButton").addEventListener("click", deleteSelectedFiles);
  $("#exportButton").addEventListener("click", exportCurrentSrt);
  $("#batchExportButton").addEventListener("click", exportBatchSrt);

  $("#brandButton").addEventListener("click", showBrandIntro);
  $("#closeAboutButton").addEventListener("click", closeBrandIntro);
  $("#brandHomeButton").addEventListener("click", () => openLink(withUiLanguageUtm(BRAND.homepage)));
  $("#brandStarButton").addEventListener("click", () => openLink(BRAND.github));
  $("#brandGuideButton").addEventListener("click", () => {
    const filename = state.settings.uiLanguage === "en" ? "USER_GUIDE.en.md" : "USER_GUIDE.md";
    openLink(`${BRAND.github}/blob/${BRAND.guideBranch}/docs/${filename}`);
  });
  $("#brandBusinessButton").addEventListener("click", () => openLink(withUiLanguageUtm(BRAND.business)));

  videoPlayer.addEventListener("timeupdate", () => {
    // 拖动进度条期间别被播放器上报的旧位置拉回去。
    if (scrubState) return;
    updateVideoTime();
    syncTransport((videoPlayer.currentTime || 0) * 1000);
  });
  videoPlayer.addEventListener("loadeddata", () => {
    posterState.classList.add("hidden");
    updatePlayerControls();
  });
  ["loadedmetadata", "durationchange", "progress", "emptied"].forEach((event) => {
    videoPlayer.addEventListener(event, () => updatePlayerControls());
  });
  videoPlayer.addEventListener("play", () => {
    hideStill();
    updatePlayerControls();
  });
  videoPlayer.addEventListener("pause", () => updatePlayerControls());
  videoPlayer.addEventListener("ended", () => updatePlayerControls());
  videoPlayer.addEventListener("volumechange", () => updatePlayerControls());
  videoPlayer.addEventListener("ratechange", () => updatePlayerControls());
  bindPlayerControls();
  updatePlayerControls();
  videoPlayer.addEventListener("error", () => {
    const file = getCurrentFile();
    // Chromium cannot decode every container; point at the workaround instead
    // of showing a dead player.
    if (file) {
      // 探测说能播、Chromium 却不认（典型是 HEVC 封装成 MP4）：直接给一次
      // "准备预览"的入口，强制重封装/转码。
      showPreviewFallback(file, t("这个视频无法在应用内播放"), { allowPrepare: true });
    }
  });

  document.addEventListener("keydown", (event) => {
    // Ctrl/⌘+Z：撤回校对改动（每个视频自己记最近 20 步）。焦点在搜索框、设置
    // 项这类输入框里时不动，让浏览器自带的输入撤销生效。
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey
      && String(event.key).toLowerCase() === "z") {
      const target = event.target;
      const inSubtitleList = Boolean(subtitleList)
        && typeof subtitleList.contains === "function"
        && subtitleList.contains(target);
      if (isTextEntry(target) && !inSubtitleList) return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      undoCueEdit();
      return;
    }
    // 拖动分隔条时 Esc 同样只回滚这次拖动。
    if (event.key === "Escape" && proofreadSplitDrag) {
      endProofreadSplitterDrag(null, { cancel: true });
      return;
    }
    // 拖动时间轴时 Esc 只回滚这一次拖动，不关弹窗。
    if (event.key === "Escape" && timelineDrag) {
      endTimelineDrag(null, { cancel: true });
      return;
    }
    if (event.key === "Escape") {
      [onboardingModal, errorModal, settingsModal, aboutModal].forEach((modal) => {
        if (!modal.classList.contains("hidden")) hide(modal);
      });
      return;
    }
    // 播放快捷键：焦点在输入框/下拉里（改字幕时间就是这种）或者弹窗开着时一个都不抢。
    if (isTextEntry(event.target) || anyModalOpen()) return;
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      togglePlayback();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      nudgePlayback(event.key === "ArrowLeft" ? -1 : 1, event.shiftKey ? 10 : 1);
      return;
    }
    // [ / ] 把当前字幕的起点 / 终点设到播放头位置。
    if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      setActiveCueEdge(event.key === "[" ? "start" : "end");
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      seekToExtreme(event.key === "Home" ? "start" : "end");
    }
  });

  // 退出前把还在防抖里的编辑发出去（尽力而为：IPC 已发出，后端可能同时被收尾）。
  window.onbeforeunload = () => {
    flushPendingCues();
    persistUi();
  };
  // 主进程关窗口时会先等这一下：回传完再真的关（否则最后一秒的编辑会丢）。
  window.subtitleApp?.onFlushRequest?.(async () => {
    try {
      // 方案 C：关窗口这一刻的播放头最有意义，先把它连同视图一起记下来。
      persistUi();
      await flushPendingCues();
      // 关窗前把最新的任务列表落下去（防抖里那次也一起）。
      await persistSessionNow();
    } finally {
      window.subtitleApp?.flushDone?.();
    }
  });
  // 关窗口前主进程还会问一次"还有没有任务在跑"：识别中要弹确认框，别默默作废这一轮。
  window.subtitleApp?.onBusyQuery?.(() => hasRunningTasks());
}

function setTheme(theme) {
  state.theme = theme;
  persistUi();
  document.body.classList.toggle("theme-light", theme === "light");
  document.body.classList.toggle("theme-dark", theme === "dark");
  $("#settingsLightButton").classList.toggle("active", theme === "light");
  $("#settingsDarkButton").classList.toggle("active", theme === "dark");
  $("#themeToggleButton").title = theme === "dark" ? t("切换浅色") : t("切换深色");
}

function toggleTheme() {
  setTheme(state.theme === "dark" ? "light" : "dark");
}

function renderPalettePicker() {
  const picker = $("#palettePicker");
  picker.innerHTML = PALETTES.map(
    (palette) =>
      `<button type="button" data-palette="${palette.id}" title="${palette.name}" aria-label="${palette.name}" aria-pressed="false" style="--palette-color:${palette.accent}"><i aria-hidden="true"></i></button>`
  ).join("");
  picker.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => setPalette(button.dataset.palette));
  });
}

function setPalette(id) {
  // 旧黄色迁移到橙色，旧青色和无效存档回落到默认蓝色。
  const migratedId = id === "warm" ? "graphite" : id;
  const palette = PALETTES.find((item) => item.id === migratedId) || PALETTES[0];
  state.palette = palette.id;
  persistUi();
  document.body.dataset.palette = palette.id;
  const aboutLogo = $("#aboutLogo");
  if (aboutLogo) aboutLogo.src = `./icons/icon-${palette.id}.png`;
  window.subtitleApp?.setWindowIcon(palette.id);
  $$("#palettePicker button").forEach((button) => {
    const selected = button.dataset.palette === palette.id;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  persistUi();
  document.body.classList.toggle("sidebar-collapsed", state.sidebarCollapsed);
  $("#collapseSidebarButton").title = state.sidebarCollapsed ? t("展开侧边栏") : t("收起侧边栏");
}

function setUiScale(value) {
  state.uiScale = ["compact", "standard", "large"][value] || "standard";
  persistUi();
  document.body.classList.toggle("scale-compact", state.uiScale === "compact");
  document.body.classList.toggle("scale-large", state.uiScale === "large");
  syncUiScaleForm();
}

// 设置窗里的缩放滑杆回填。它以前只在「恢复默认」时被写过一次，重开程序后一直停在
// HTML 里的默认位置（= 中间那格），跟实际存下来的小 / 大对不上。
function syncUiScaleForm() {
  const index = ["compact", "standard", "large"].indexOf(state.uiScale);
  $("#uiScaleRange").value = String(index >= 0 ? index : 1);
  $("#uiScaleOutput").textContent =
    { get compact() { return t("小"); }, get standard() { return t("标准"); }, get large() { return t("大"); } }[state.uiScale] || t("标准");
}

function showView(view) {
  state.currentView = view;
  $("#proofreadView").classList.toggle("active", view === "proofread");
  $("#fileManagerView").classList.toggle("active", view === "files");
  $("#proofreadNavButton").classList.toggle("active", view === "proofread");
  $("#fileManagerButton").classList.toggle("active", view === "files");
  $("#settingsButton").classList.remove("active");
  // 隐藏时量不到宽度，切回校对页补一次（否则第一次进来会一直是 CSS 兜底比例）。
  if (view === "proofread") applyProofreadSplit();
  // C3：记住上次停在哪个视图（启动恢复那一次不算，见 applyPendingUiView）。
  if (state.uiRestore.viewApplied) persistUi();
}

function showSetup() {
  renderPendingList();
  show(onboardingModal);
}

function hideSetup() {
  // 关得掉才像关闭按钮：没选视频时也允许关，侧边栏的「新建任务」随时能再打开。
  hide(onboardingModal);
}

function saveSettings() {
  persistUi();
  readSettingsFromForm();
  hide(settingsModal);
  showToast(t("设置已保存"));
}

function resetSettings() {
  setTheme("light");
  setPalette("neon");
  setUiScale(1);
  $("#autoSaveToggle").checked = true;
  $("#followPlaybackToggle").checked = true;
  $("#nativeControlsToggle").checked = false;
  $("#introOnStartupToggle").checked = true;
  state.settings = defaultSettings();
  setUiLanguage(state.settings.uiLanguage, false);
  applySettingsToForm();
  persistSettings();
  persistUi();
  updateOcrLabel();
  updatePlayerControls();
  showToast(t("已恢复默认设置"));
}

function show(element) {
  element.classList.remove("hidden");
}

function hide(element) {
  element.classList.add("hidden");
}

// 品牌介绍弹窗：冷启动先给用户看一次（设置里可关）；点 × 把它「收」进左上角的
// 品牌图标，让用户记住入口在哪。
function showBrandIntro() {
  // 收起动效期间遮罩不挡点击，此时再点入口以「这次打开」为准，别被旧的收尾关掉。
  brandIntroEpoch += 1;
  brandIntroCollapsing = false;
  aboutModal.classList.remove("brand-collapsing");
  const panel = aboutModal.querySelector(".about-modal");
  if (panel && typeof panel.getAnimations === "function") {
    panel.getAnimations().forEach((item) => item.cancel());
  }
  show(aboutModal);
}

// 启动时的入口：设置里关掉就完全不出面（想看点左上角图标）。
function maybeShowBrandIntro() {
  if (state.settings.showIntroOnStartup === false) return;
  showBrandIntro();
}

function closeBrandIntro() {
  if (brandIntroCollapsing || aboutModal.classList.contains("hidden")) return;
  const panel = aboutModal.querySelector(".about-modal");
  const anchor = $("#brandButton");
  const from = panel && panel.getBoundingClientRect ? panel.getBoundingClientRect() : null;
  const to = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  // 量不到尺寸（窗口还没显示）时直接关，别留半截动画。系统关了动画效果
  // （远程桌面 / 虚拟机默认就是关的）也照播：这是指认入口的引导，得让用户看见。
  const canAnimate = typeof panel?.animate === "function"
    && from && to && from.width > 0 && to.width > 0;
  const epoch = ++brandIntroEpoch;
  let animation = null;
  let settled = false;
  const finish = () => {
    if (settled || epoch !== brandIntroEpoch) return;
    settled = true;
    brandIntroCollapsing = false;
    aboutModal.classList.remove("brand-collapsing");
    if (animation) {
      try {
        animation.cancel();
      } catch (error) {
        // 已经结束的动画 cancel 会抛，忽略。
      }
    }
    hide(aboutModal);
    pulseBrandMark();
    showToast(t("品牌介绍已收起 · 点左上角图标可再次查看"));
    // 方案 C：介绍窗关了才动视图 / 播放头。
    applyPendingUiView();
    applyPendingUiPosition();
  };
  if (!canAnimate) {
    finish();
    return;
  }
  brandIntroCollapsing = true;
  aboutModal.classList.add("brand-collapsing");
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const scale = Math.max(0.06, to.width / from.width);
  animation = panel.animate([
    { transform: "translate(0px, 0px) scale(1)", opacity: 1 },
    {
      transform: `translate(${(dx * 0.74).toFixed(1)}px, ${(dy * 0.74).toFixed(1)}px) scale(${((1 + scale) / 2).toFixed(3)})`,
      opacity: 0.9,
      offset: 0.66
    },
    { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(3)})`, opacity: 0 }
  ], { duration: 620, easing: "cubic-bezier(0.32, 0.04, 0.22, 1)", fill: "forwards" });
  Promise.resolve(animation.finished).then(finish, finish);
  // 动效被系统打断（最小化、切走）时也要收尾，别把弹窗留在半路上。
  setTimeout(finish, 900);
}

// 收完之后让左上角入口闪一下，指认「下次看这里」。
function pulseBrandMark() {
  const anchor = $("#brandButton");
  if (!anchor || !anchor.classList) return;
  anchor.classList.add("brand-attention");
  setTimeout(() => anchor.classList.remove("brand-attention"), 1800);
}

// 与主进程一致的容器白名单：拖 / 选进来的东西先在渲染层挡一道，
// 免得 .lnk、文件夹、图片一路跑到解码器才报"识别过程中出错"。
const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "avi", "webm"];

function looksLikeSupportedVideo(name) {
  const text = String(name || "");
  const dot = text.lastIndexOf(".");
  if (dot <= 0) return false;
  return SUPPORTED_VIDEO_EXTENSIONS.includes(text.slice(dot + 1).toLowerCase());
}

function unsupportedVideoReason() {
  return t("只支持 {0}，请换成视频文件本身", [SUPPORTED_VIDEO_EXTENSIONS.join(" / ")]);
}

// 被挡下的文件要说清楚，不然用户以为自己选丢了。
function notifyRejectedVideos(rejected) {
  const list = Array.isArray(rejected) ? rejected.filter(Boolean) : [];
  if (!list.length) return;
  const extra = list.length > 1 ? t("（另有 {0} 个同样被跳过）", [list.length - 1]) : "";
  const first = list[0];
  showToast(t("已跳过 {0}：{1}{2}", [first.name || t("这个文件"), first.reason || unsupportedVideoReason(), extra]));
}

async function chooseVideos() {
  if (window.subtitleApp?.chooseVideos) {
    const picked = await window.subtitleApp.chooseVideos();
    // 主进程给的是 { videos, rejected }；旧版返回数组时也要能用。
    const videos = Array.isArray(picked) ? picked : (picked?.videos || []);
    const rejected = Array.isArray(picked) ? [] : (picked?.rejected || []);
    if (videos.length) applyVideos(videos);
    notifyRejectedVideos(rejected);
    return;
  }
  $("#browserVideoInput").click();
}

// 拖进窗口的视频必须用 webUtils 换成真实路径，后端才认得。
function bindDropZone() {
  // 绑在虚线框本身：空态时里面是"点击选择"按钮，选完由已选列表接管这块区域，
  // 两种状态都得能接住拖进来的文件。
  const zone = $("#pickZone");
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  zone.addEventListener("dragover", (event) => {
    stop(event);
    zone.classList.add("dropping");
  });
  zone.addEventListener("dragleave", (event) => {
    stop(event);
    zone.classList.remove("dropping");
  });
  zone.addEventListener("drop", async (event) => {
    stop(event);
    zone.classList.remove("dropping");
    const dropped = [...((event.dataTransfer && event.dataTransfer.files) || [])];
    if (!dropped.length) return;
    const api = window.subtitleApp;
    const paths = dropped.map((file) => (api?.getPathForFile ? api.getPathForFile(file) : ""));
    // 主进程认得快捷方式、也认得出文件夹：交给它判，挡下的会带原因回来。
    if (api?.resolveVideoPaths && paths.every(Boolean)) {
      const picked = await api.resolveVideoPaths(paths);
      if (picked?.videos?.length) applyVideos(picked.videos);
      notifyRejectedVideos(picked?.rejected);
      return;
    }
    // 浏览器里跑（拿不到真实路径）：只能按文件名粗筛一遍。
    const kept = [];
    const skipped = [];
    dropped.forEach((file, index) => {
      const realPath = paths[index];
      if (looksLikeSupportedVideo(file.name)) {
        kept.push({
          name: file.name,
          path: realPath || file.name,
          url: realPath ? "" : URL.createObjectURL(file)
        });
      } else {
        skipped.push({ name: file.name, reason: unsupportedVideoReason() });
      }
    });
    if (kept.length) applyVideos(kept);
    notifyRejectedVideos(skipped);
  });
  // 掉在窗口其它地方的文件不该把页面导航走。
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("drop", (event) => event.preventDefault());
}

function handleBrowserVideos(event) {
  const picked = [...event.target.files];
  const videos = picked
    .filter((file) => looksLikeSupportedVideo(file.name))
    .map((file) => ({
      name: file.name,
      path: file.name,
      url: URL.createObjectURL(file)
    }));
  const skipped = picked
    .filter((file) => !looksLikeSupportedVideo(file.name))
    .map((file) => ({ name: file.name, reason: unsupportedVideoReason() }));
  if (videos.length) applyVideos(videos);
  notifyRejectedVideos(skipped);
}

// 入口上显示"这次点开始会跑哪些视频"：分批导入时是累计个数，不是最后一批。
const VIDEO_PICK_HINT = "拖入视频文件或点击选择";

function updateVideoPickLabel() {
  const label = $("#videoPickLabel");
  if (!label) return;
  const pending = state.pendingIds
    .map((id) => state.files.find((file) => file.id === id))
    .filter(Boolean);
  label.textContent = pending.length === 0
    ? t(VIDEO_PICK_HINT)
    : t("继续添加视频 · 已选 {0} 个视频", [pending.length]);
}

// 新建任务弹窗里的"已选视频"列表：看得见具体选了哪些，能勾选、能移除、能继续添加。
function pendingFiles() {
  return state.pendingIds
    .map((id) => state.files.find((file) => file.id === id))
    .filter(Boolean);
}

function renderPendingList() {
  const picker = $("#pendingPicker");
  const list = $("#pendingList");
  if (!picker || !list) return;
  const pending = pendingFiles();
  // 已经不在待跑集合里的（跑过 / 删过）不该还留着勾。
  const alive = new Set(pending.map((file) => file.id));
  state.setupSelectedIds = new Set(
    [...state.setupSelectedIds].filter((id) => alive.has(id)));
  picker.classList.toggle("hidden", pending.length === 0);
  $("#pickZone")?.classList.toggle("has-pending", pending.length > 0);
  $("#pendingSummary").textContent = t("已选择 {0} 个视频", [pending.length]);
  const allSelected = pending.length > 0 && state.setupSelectedIds.size === pending.length;
  $("#pendingSelectAllButton").textContent = allSelected ? t("全不选") : t("全选");
  $("#pendingRemoveButton").disabled = state.setupSelectedIds.size === 0;
  list.innerHTML = pending.map((file) => {
    const checked = state.setupSelectedIds.has(file.id);
    return `
      <label class="pending-row${checked ? " selected" : ""}">
        <input type="checkbox" data-pending-id="${escapeHtml(file.id)}"${checked ? " checked" : ""} />
        <span class="pending-name" title="${escapeHtml(file.path || file.name)}">${escapeHtml(file.name)}</span>
        <button class="pending-remove" type="button" data-pending-remove="${escapeHtml(file.id)}" title="${t("移除这个视频")}" aria-label="${t("移除 ")}${escapeHtml(file.name)}">×</button>
      </label>`;
  }).join("");
}

function onPendingListChange(event) {
  const id = event.target?.dataset?.pendingId;
  if (!id) return;
  if (event.target.checked) state.setupSelectedIds.add(id);
  else state.setupSelectedIds.delete(id);
  renderPendingList();
}

function onPendingListClick(event) {
  const id = event.target?.dataset?.pendingRemove;
  if (!id) return;
  // 行是 label：不拦一下，点 × 会顺手把复选框也切了。
  event.preventDefault();
  event.stopPropagation();
  removePendingVideos([id]);
}

function toggleSelectAllPending() {
  const pending = pendingFiles();
  const allSelected = pending.length > 0 && state.setupSelectedIds.size === pending.length;
  state.setupSelectedIds = allSelected
    ? new Set()
    : new Set(pending.map((file) => file.id));
  renderPendingList();
}

function removeSelectedPending() {
  const ids = pendingFiles()
    .map((file) => file.id)
    .filter((id) => state.setupSelectedIds.has(id));
  if (!ids.length) {
    showToast(t("请先勾选要移除的视频"));
    return;
  }
  removePendingVideos(ids);
}

// 从"这次要跑哪些"里摘掉：任务列表和后端登记也一起删，别留个待处理的空行。
// 这些视频还没开跑，所以不给原生确认框（不是删已有成果）。
function removePendingVideos(ids) {
  const targets = ids.filter((id) => state.pendingIds.includes(id));
  if (!targets.length) return;
  targets.forEach((id) => {
    dropPendingCues(id);
    cancelPreviewJob(findFile(id));
    window.ocrSession?.removeTask(id).catch(() => {});
    state.setupSelectedIds.delete(id);
    removeFileLocally(id);
  });
  renderPendingList();
  showToast(t("已从这次任务里移除 {0} 个视频", [targets.length]));
}

function applyVideos(videos) {
  state.pendingVideos = videos;
  const newTasks = videos.map((video) => createFileTask(video));
  state.files = [...state.files, ...newTasks];
  // 分两批选进来的视频要一起跑：pendingIds 是"这次还没开始的视频"，只能累加。
  // 用赋值覆盖的话先选的那批会被丢掉，点开始时只剩最后一批（实测选两次只跑一个）。
  const pending = new Set(state.pendingIds);
  newTasks.forEach((task) => pending.add(task.id));
  state.pendingIds = [...pending];
  updateVideoPickLabel();
  renderPendingList();
  if (!state.currentFileId && newTasks[0]) state.currentFileId = newTasks[0].id;
  renderFiles();
  // 新建任务（选视频 / 拖进选区）之后直接落到文件管理页：任务和进度都在那儿。
  showView("files");
  registerTasks(newTasks);
  showToast(t("已添加 {0} 个视频", [videos.length]));
}

function createFileTask(video) {
  const id = `file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    name: video.name,
    path: video.path || "",
    url: video.url || "",
    // 后端状态机（SIDECAR_API.md 4.4），这里只做镜像
    status: "idle",
    progress: 0,
    message: t("等待处理"),
    error: null,
    outputPath: null,
    durationMs: 0,
    fps: 0,
    revision: 0,
    cues: [],
    activeCueId: null,
    // 方案 C：上次的播放头，等画面能 seek 了再落一次（探测 / 预览都是异步的）。
    pendingSeekMs: null,
    pendingSeekBound: false,
    // 会话恢复用：这一行是不是由 task.restore 接管的、要不要用户重新选文件。
    restoring: false,
    restored: false,
    needsRelink: false,
    restoreNotice: "",
    // 这个视频自己的撤回历史（最近 20 步，只存纯数据）；删任务 / 关程序即释放。
    history: { entries: [] },
    previewPath: null,
    previewJobId: null,
    previewUnavailable: false,
    previewMessage: "",
    previewCanPrepare: false,
    probed: false
  };
}

async function chooseDirectory() {
  if (window.subtitleApp?.chooseDirectory) {
    const directory = await window.subtitleApp.chooseDirectory();
    if (directory) $("#outputDirInput").value = directory;
    return;
  }
  showToast(t("浏览器预览中使用默认输出目录"));
}

// OCR 区域固定自动；这里如实显示会传给后端的语言与采样间隔。
function updateOcrLabel() {
  if (!state.backend.ready) {
    $("#ocrModeLabel").textContent = state.backend.error ? t("后端不可用") : t("正在连接后端…");
    return;
  }
  const settings = state.settings;
  const language = languageLabel(settings.language);
  $("#ocrModeLabel").textContent = t("自动选区 · {0} · 每 {1} 帧", [language, settings.frameInterval]);
}

function buildOptions() {
  const capabilities = state.backend.capabilities || {};
  const interval = capabilityBounds(capabilities.frameInterval, FRAME_INTERVAL_FALLBACK);
  const cpuThreads = capabilityBounds(capabilities.cpuThreads, CPU_THREADS_FALLBACK);
  return {
    language: state.settings.language,
    frameInterval: normalizeFrameInterval(state.settings.frameInterval, null, interval),
    threshold: currentThreshold(),
    // 检测并发本身仍不交给界面，CPU 预算由下面的 cpuThreads 控制。
    detWorkers: (capabilities.detWorkers && capabilities.detWorkers.default) || 1,
    cpuThreads: clampCpuThreads(state.settings.cpuThreads, cpuThreads),
    // auto / cpu / gpu —— 后端只把不可用的执行器过滤掉，不会因为它跑不起来。
    device: normalizeDeviceChoice(state.settings.device),
    roiMode: "auto",
    outputDir: state.settings.outputDir || null,
    writeSrt: true
  };
}

// 控件范围由 system.capabilities 驱动，不在前端写死。
function applyCapabilities(capabilities) {
  const caps = capabilities || {};
  if (Array.isArray(caps.languages) && caps.languages.length) {
    const select = $("#languageSelect");
    languageLabels = Object.fromEntries(
      caps.languages.map((item) => [item.code, item.label]));
    select.innerHTML = caps.languages
      .map((item) => `<option value="${escapeHtml(item.code)}">${escapeHtml(languageLabel(item.code))}</option>`)
      .join("");
    const codes = caps.languages.map((item) => item.code);
    if (!codes.includes(state.settings.language)) state.settings.language = codes[0];
  }
  const threshold = caps.threshold;
  if (threshold) {
    const bounds = capabilityBounds(threshold, THRESHOLD_FALLBACK);
    const range = $("#thresholdRange");
    range.min = String(bounds.min);
    range.max = String(bounds.max);
    range.step = String(threshold.step || 0.01);
    const stored = state.settings.thresholds || {};
    state.settings.thresholds = Object.fromEntries(Object.entries(stored).map(
      ([code, value]) => [code, clampNumber(value, bounds.min, bounds.max, bounds.default)]));
  }
  if (caps.frameInterval) {
    const bounds = capabilityBounds(caps.frameInterval, FRAME_INTERVAL_FALLBACK);
    const input = $("#sampleGapInput");
    input.min = String(bounds.min);
    input.max = String(bounds.max);
    state.settings.frameInterval = normalizeFrameInterval(
      state.settings.frameInterval, null, bounds);
  }
  if (caps.cpuThreads) {
    const bounds = capabilityBounds(caps.cpuThreads, CPU_THREADS_FALLBACK);
    const input = $("#cpuThreadsInput");
    input.min = String(bounds.min);
    input.max = String(bounds.max);
    $("#cpuThreadsHint").textContent = t("线程（{0}–{1}）", [bounds.min, bounds.max]);
    // 换设备后旧值可能超出本机范围，这种历史值不再适用：回到"跟本机默认"。
    const chosen = state.settings.cpuThreads;
    state.settings.cpuThreads = (chosen == null || chosen < bounds.min || chosen > bounds.max)
      ? null
      : Math.round(chosen);
  }
  const device = caps.device;
  if (device) {
    const options = Array.isArray(device.options) && device.options.length
      ? device.options
      : DEVICE_FALLBACK;
    deviceOptions = [...options];
    const select = $("#deviceSelect");
    select.innerHTML = options.map((value) => {
      const label = DEVICE_LABELS[value] || value;
      return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
    }).join("");
    // 存的是这台机器上没有的选项（换了设备）时回落默认值。
    state.settings.device = normalizeDeviceChoice(state.settings.device);
    // 没有可用显卡时把话说明白，别让用户以为选了 GPU 就在用 GPU。
    const hint = $("#deviceHint");
    if (hint) {
      hint.textContent = device.gpuAvailable
        ? `GPU：${device.gpuBackend || t("可用")}`
        : t("未检测到可用显卡");
    }
  } else {
    // 老后端根本不认这个选项：回到 auto（它会忽略该字段，行为与旧版一致）。
    state.settings.device = "auto";
  }
  applySettingsToForm();
  persistSettings();
}

function updateBackendUi() {
  const ready = state.backend.ready;
  const button = $("#startRecognizeButton");
  if (button) {
    // 按钮一直可点：后端还在冷启动时点了会挂上进度窗口等它起来，真起不来才报错。
    // 旧版"未就绪就置灰"会让首次点识别看起来完全没反应。
    button.disabled = false;
    button.title = ready ? "" : (state.backend.error || t("OCR 后端尚未就绪，点击后会等后端启动"));
  }
  updateOcrLabel();
}

function wireBackendEvents() {
  if (state.backend.wired) return;
  state.backend.wired = true;
  window.ocrSession.onEvent(handleBackendEvent);
  window.ocrSession.onStatus(handleBackendStatus);
}

function handleBackendStatus(status) {
  if (!status) return;
  if (status.state === "stopped") return;
  if (status.state === "ready") {
    // 后端就绪但界面还没接上：自动重连成功，或者首次握手比渲染层预期晚了一步
    // （这种情况下也要接上，否则按钮和能力表会一直停在"未就绪"）。
    // 自动重连成功（没弹过错误框）：这一轮被打断过就得说一声，否则用户只在
    // 文件列表里看到一行小字，点"重新识别"也不知道刚才发生了什么。
    if (state.backend.interrupted || state.backend.stalled) {
      const hit = state.backend.interrupted;
      const stall = state.backend.stalled;
      state.backend.interrupted = null;
      state.backend.stalled = null;
      if (stall && !hit) {
        showToast(t("OCR 后端卡死已自动重启，这个视频需要重新识别"));
      } else if (stall) {
        showToast(t("OCR 后端卡死已自动重启：被打断的 {0} 个视频需要重新识别", [hit.count]));
      } else {
        showToast(t("OCR 后端已重连：被打断的 {0} 个视频需要重新识别", [hit.count]));
      }
    }
    // bootstrapBackend 自带去重，不会和 connect() 抢着跑。
    if (!state.backend.ready) bootstrapBackend();
    return;
  }
  if (status.state === "reconnecting") {
    state.backend.ready = false;
    state.backend.error = t("OCR 后端已退出，正在自动重连…");
    updateBackendUi();
    if (status.attempt === 1) showToast(t("OCR 后端已退出，正在自动重连…"));
    return;
  }
  if (status.state === "exited" || status.state === "missing") {
    // 正在跑/排队的任务不会再有任何事件回来：标成失败，等用户重新识别。
    const interrupted = markInterruptedFiles();
    // 这一轮被意外打断过就记下来：自动重连用尽时才能说清"为什么得重跑"。
    if (interrupted.length) {
      state.backend.interrupted = { count: interrupted.length, path: interrupted[0] };
    }
    state.backend.ready = false;
    state.backend.error = status.detail || t("OCR 后端已退出");
    updateBackendUi();
    hide(loadingModal);
    renderFiles();
    // 自动重连还有机会就先不打断用户；次数用尽或找不到后端时才给重连入口。
    if (status.willRetry) return;
    const hit = state.backend.interrupted;
    state.backend.interrupted = null;
    if (hit) {
      // 识别是被意外打断的：弹错误框（错误码 + 现场已经由主进程落盘），
      // 重连入口就做在框里——提示条会被遮罩挡住点不到。
      showError({
        code: status.state === "missing" ? "E_BACKEND_NOT_READY" : "E_BACKEND_EXITED",
        message: t("OCR 后端意外退出，这一轮识别没有完成（{0} 个视频）", [hit.count]),
        detail: typeof status.detail === "string" ? status.detail : "",
        videoPath: hit.path,
        // 主进程自己也会写一条 sidecar.exit（带 stderr 现场）；这条是弹窗视角，带视频路径。
        source: "sidecar.exit.dialog"
      });
      return;
    }
    showToast(status.state === "missing"
      ? t("找不到 OCR 后端，点这里重试")
      : t("OCR 后端已退出，点这里重新连接"), {
      get label() { return t("重新连接"); },
      onClick: () => reconnectBackend()
    });
  }
}

// 识别还在跑时关窗口会把这一轮作废（后端进程跟着一起退出）：主进程据此弹确认框。
function hasRunningTasks() {
  if (state.running || state.queue.runningId) return true;
  return state.files.some(
    (file) => file.status === "running" || file.status === "waiting");
}

// 后端进程没了：running/waiting 的行不会再有事件，标成失败并交回按钮给用户。
function markInterruptedFiles() {
  // 返回被这一下打断的视频路径：调用方据此决定要不要弹错误框（只标了行不行）。
  const interrupted = [];
  state.files.forEach((file) => {
    if (file.status !== "running" && file.status !== "waiting") return;
    file.status = "failed";
    file.progress = 0;
    // 看门狗已经按"识别卡住"收过尾的行：保留真实原因（用户据此判断
    // 是不是设备/驱动的问题），别让"后端已退出"把它盖掉。
    const stalled = Boolean(file.error && file.error.code === "E_OCR_STALLED");
    file.message = stalled ? file.message : t("后端已退出，需重新识别");
    file.error = stalled ? file.error : { code: "E_BACKEND_EXITED", get message() { return t("OCR 后端进程已退出"); } };
    interrupted.push(file.path);
  });
  state.queue.runningId = null;
  state.running = false;
  return interrupted;
}

// 手动重连：缓存的启动 promise 已经在 exit 里清掉，connect() 会重新 spawn。
async function reconnectBackend() {
  hide(loadingModal);
  await bootstrapBackend();
}

// 把新加入的视频注册到后端队列（幂等：重复注册只会回传当前状态）。
async function registerTasks(files) {
  if (!state.backend.ready) return;
  for (const file of files) {
    if (!file.path) continue;
    // 恢复已经接管 / 文件不在了的行不走这条路：这里的 catch 会把行冲成"失败"，
    // 把"已完成"连同 outputPath 一起冲掉（SESSION_RESTORE_DESIGN.md §3.6）。
    if (file.restoring || file.restored || file.needsRelink) continue;
    try {
      const result = await window.ocrSession.enqueue(file.id, file.path);
      if (file.status === "idle" && result) file.status = result.state;
      if (result && result.outputPath) file.outputPath = result.outputPath;
    } catch (error) {
      file.status = "failed";
      file.error = { code: error.code || "E_INTERNAL", message: error.message };
    }
  }
  renderFiles();
}

// ------------------------------------------------------- 会话恢复（方案 A）
// 任务列表跨进程保留：索引（路径 / 输出路径 / 状态 / 当时的参数）由主进程原子写进
// <userData>/session.json，字幕内容一律从磁盘 SRT 回读（SESSION_RESTORE_DESIGN.md）。
// 这里只当镜像，不当真相：拿不到快照、读不回来，都按"这次没有会话"继续。
const SESSION_SAVE_DEBOUNCE_MS = 800;
const SESSION_ITEMS_LIMIT = 500;
// 只有这两种状态算"盘上有结果"；其余（含 running/waiting）落成 null，重启后按
// 新任务重新登记——不能让上次没跑完的行变成幽灵"识别中"。
const SESSION_SETTLED_STATES = ["completed", "modified"];

let sessionSaveTimer = null;
let sessionLoadPromise = null;
let sessionRestoreQueue = [];
// 快照读完了没有：位置恢复要找的那一行得等这一步之后才在列表里。
let sessionSnapshotLoaded = false;

function sessionApi() {
  return window.subtitleApp?.session || null;
}

// 浏览器预览里的行只有文件名（拿不到真实路径），这种行没法跨进程恢复。
function isRestorablePath(path) {
  const text = String(path || "");
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith("\\\\") || text.startsWith("/");
}

function fileNameFromPath(path) {
  return String(path || "").split(/[\\/]/).pop() || String(path || "");
}

function sessionItem(file) {
  const settled = SESSION_SETTLED_STATES.includes(file.status);
  return {
    id: file.id,
    path: file.path,
    name: file.name,
    outputPath: file.outputPath || null,
    state: settled ? file.status : null,
    completedConfig: settled ? (file.completedConfig || null) : null,
    durationMs: Math.round(Number(file.durationMs) || 0),
    fps: Number(file.fps) || 0
  };
}

// 只有这几项变化才值得写盘：进度事件每 100ms 一次，落盘不能跟着它转。
function sessionSignature(file) {
  return [
    file.status,
    file.path || "",
    file.name || "",
    file.outputPath || "",
    Math.round(Number(file.durationMs) || 0),
    Number(file.fps) || 0,
    Array.isArray(file.completedConfig) ? file.completedConfig.join("|") : ""
  ].join("~");
}

function sessionSnapshot() {
  return {
    items: state.files
      .filter((file) => file.path && isRestorablePath(file.path))
      .slice(0, SESSION_ITEMS_LIMIT)
      .map(sessionItem)
  };
}

async function persistSessionNow() {
  if (sessionSaveTimer) {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = null;
  }
  const api = sessionApi();
  if (!api) return;
  try {
    await api.save(sessionSnapshot());
  } catch (error) {
    /* 写不进去不影响使用：下次状态变化还会再试一次 */
  }
}

function persistSessionSoon() {
  if (!sessionApi() || sessionSaveTimer) return;
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    persistSessionNow();
  }, SESSION_SAVE_DEBOUNCE_MS);
}

// 启动时读一次快照：先把行摆出来（按上次的状态），字幕等内容等后端回读。
function loadSessionSnapshot() {
  if (sessionLoadPromise) return sessionLoadPromise;
  sessionLoadPromise = (async () => {
    const api = sessionApi();
    if (!api) return [];
    let payload = null;
    try {
      payload = await api.load();
    } catch (error) {
      return [];
    }
    const items = (payload && payload.snapshot && payload.snapshot.items) || [];
    if (!items.length) return [];
    const seen = new Set();
    const restored = [];
    items.forEach((raw) => {
      const item = raw || {};
      const path = String(item.path || "").trim();
      if (!path || !isRestorablePath(path)) return;
      const key = path.toLowerCase();
      if (seen.has(key)) return;   // 同一路径只留先出现的那一行
      seen.add(key);
      const file = createFileTask({
        name: String(item.name || "").trim() || fileNameFromPath(path),
        path
      });
      file.outputPath = item.outputPath || null;
      file.durationMs = Math.round(Number(item.durationMs) || 0);
      file.fps = Number(item.fps) || 0;
      file.completedConfig = item.completedConfig || null;
      const settled = SESSION_SETTLED_STATES.includes(item.state);
      file.status = settled ? item.state : "idle";
      file.message = settled ? t("正在恢复上次的字幕…") : t("等待处理");
      // 有结果的行走 task.restore（只读回读 SRT）；没跑完的走普通登记。
      file.restoring = settled;
      if (settled) restored.push({ file, item });
      state.files.push(file);
    });
    sessionRestoreQueue = restored;
    if (!state.currentFileId && state.files[0]) state.currentFileId = state.files[0].id;
    renderFiles();
    if (restored.length) {
      showToast(t("已恢复上次的 {0} 个任务", [state.files.length]));
    }
    return restored;
  })().finally(() => {
    sessionSnapshotLoaded = true;
  });
  return sessionLoadPromise;
}

// 交给后端只读回读（一次 IPC）：字幕从磁盘来，completed_config 播回去。
async function restoreSessionTasks() {
  if (!sessionRestoreQueue.length) return;
  // 后端没握上手（缺模型 / 进程起不来）：不能把这些行一直挂在"正在恢复"上，
  // 退回"待重跑"，重连之后用户点开始就能再跑。
  if (!state.backend.ready) {
    downgradePendingRestores("backend-unavailable");
    return;
  }
  const queue = sessionRestoreQueue;
  sessionRestoreQueue = [];
  let result = null;
  try {
    result = await window.ocrSession.restoreTasks(queue.map((entry) => ({
      taskId: entry.file.id,
      videoPath: entry.file.path,
      outputPath: entry.file.outputPath,
      state: entry.item.state,
      completedConfig: entry.item.completedConfig
    })));
  } catch (error) {
    // 恢复整批失败：行退回"待重跑"，用户点开始就能再跑一遍。
    queue.forEach((entry) => downgradeRestoredRow(entry.file, "restore-failed"));
    renderFiles();
    showToast(t("上次的字幕没能恢复，需要重新识别"));
    return;
  }
  const byId = new Map(
    ((result && result.items) || []).map((item) => [item.taskId, item]));
  let restored = 0;
  let skipped = 0;
  queue.forEach((entry) => {
    const item = byId.get(entry.file.id);
    if (item && applyRestoreResult(entry.file, item)) restored += 1;
    else {
      downgradeRestoredRow(entry.file, (item && item.reason) || "restore-failed");
      skipped += 1;
    }
  });
  renderFiles();
  // 字幕回来了要刷新列表——不只是队列第一行：位置恢复（方案 C）可能早就选中了靠后的
  // 那一个视频（介绍窗早关时就是这个顺序），它也得立刻把字幕显示出来。
  const current = state.files.find((file) => file.id === state.currentFileId) || null;
  if (current && queue.some((entry) => entry.file.id === current.id)) {
    renderSubtitles();
    // 位置恢复比字幕回读先跑时，要选中的那条字幕当时还不在列表里，这里补一次。
    const wanted = state.uiRestore.activeSubtitleId;
    const cue = wanted === null || wanted === undefined
      ? null
      : current.cues.find((item) => item.id === Number(wanted));
    if (cue) setActiveSubtitle(cue.id);
    else updateSubtitleOverlay();
    updateRowHighlight();
  }
  if (skipped) showToast(t("{0} 个视频的字幕没能恢复，需要重新识别", [skipped]));
  return { restored, skipped };
}

function downgradePendingRestores(reason) {
  if (!sessionRestoreQueue.length) return;
  const queue = sessionRestoreQueue;
  sessionRestoreQueue = [];
  queue.forEach((entry) => downgradeRestoredRow(entry.file, reason));
  renderFiles();
}

function restoreNoticeFor(item) {
  const notices = [];
  if (item.partial) {
    notices.push(t("文件里有 {0} 条字幕无法解析，保存会丢失它们", [item.unparsedBlocks]));
  }
  if (item.configMissing) {
    notices.push(t("没有记录上次的识别参数，下次批量会重新识别这一条"));
  }
  return notices.join("；");
}

// 只认这份响应（SESSION_RESTORE_DESIGN.md §3.4）：绝不把行交给 registerTasks 的
// 失败分支——那会把"已完成 / 已修改"连同 outputPath 一起冲成"失败"。
function applyRestoreResult(file, item) {
  file.restoring = false;
  // 后端是新进程，revision 从 0 开始；留着旧值会让之后所有 task.state 被丢。
  file.revision = 0;
  if (!item.ok) {
    downgradeRestoredRow(file, item.reason);
    return false;
  }
  file.status = item.state === "modified" ? "modified" : "completed";
  file.cues = (item.cues || []).map(normalizeCue);
  file.outputPath = item.outputPath || null;
  file.durationMs = Math.round(Number(item.durationMs) || file.durationMs || 0);
  file.fps = Number(item.fps) || file.fps || 0;
  file.completedConfig = item.completedConfig || null;
  file.message = file.cues.length
    ? (file.status === "modified" ? t("已修改") : t("已完成"))
    : t("未识别到字幕");
  file.error = null;
  file.dirty = false;
  file.activeCueId = file.cues[0] ? file.cues[0].id : null;
  file.cueRevision = (file.cueRevision || 0) + 1;
  file.restoreNotice = restoreNoticeFor(item);
  file.restored = true;
  resetCueHistory(file);
  return true;
}

function downgradeRestoredRow(file, reason) {
  file.restoring = false;
  file.status = "idle";
  file.progress = 0;
  file.cues = [];
  file.revision = 0;
  file.restored = true;
  if (reason === "missing" || reason === "unsupported") {
    // 文件被挪走 / 改名：装个"重新选择"的入口，别把它标成"失败"。
    file.needsRelink = true;
    file.message = reason === "unsupported"
      ? t("这个文件不是视频，需要重新选择")
      : t("文件不在了，需要重新选择");
  } else {
    file.message = t("上次的字幕没有恢复，需要重新识别");
  }
}

// 「重新选择」：就地把这一行换成新路径，不新建行、不丢顺序。
async function relinkFile(file) {
  if (!file) return;
  const api = window.subtitleApp;
  if (!api?.chooseVideos || !api?.resolveVideoPaths) {
    showToast(t("当前环境不支持重新选择文件"));
    return;
  }
  const picked = await api.chooseVideos();
  const videos = Array.isArray(picked) ? picked : ((picked && picked.videos) || []);
  const chosen = videos[0];
  if (!chosen || !chosen.path) return;
  const previousPath = file.path;
  file.path = chosen.path;
  file.name = chosen.name || fileNameFromPath(chosen.path);
  file.needsRelink = false;
  file.restored = false;
  file.message = t("等待处理");
  file.progress = 0;
  file.url = chosen.url || file.url;
  file.previewPath = null;
  file.previewJobId = null;
  file.previewUnavailable = false;
  renderFiles();
  showToast(t("已重新选择：{0}", [file.name]));
  // 后端那边旧路径的记录要摘掉，新路径按新任务登记。
  window.ocrSession?.removeTask(file.id).catch(() => {});
  await registerTasks([file]);
  if (file.id === state.currentFileId) selectFile(file.id);
  if (previousPath && previousPath !== file.path) {
    persistSessionNow();
    // 方案 C 记的是路径：换了文件就得马上把"上次的视频"改过来。
    persistUi();
  }
}

// ------------------------------------------------------------- 后端（sidecar）
// 两小时以上的视频默认只走"重封装"；真要整片转码必须先问用户（SIDECAR_API.md 11.6）。
const LONG_VIDEO_MS = 2 * 60 * 60 * 1000;

const STAGE_TEXT = {
  get loading_model() { return t("正在加载模型"); },
  get preparing() { return t("正在准备"); },
  get scanning() { return t("正在预扫描"); },
  get detecting() { return t("正在检测字幕区域"); },
  get recognizing() { return t("正在识别字幕"); },
  get finalizing() { return t("正在整理字幕"); }
};

function stageText(stage) {
  return STAGE_TEXT[stage] || "";
}

function backendUiText(message, fallback) {
  const raw = String(message || "");
  const translated = uiI18n.message(raw);
  // Backend versions may add new diagnostic messages without a translation.
  // Use the structured stage/status for English summaries; keep original
  // diagnostics in the error details and log for troubleshooting.
  return uiI18n.language === "en" && translated === raw && /\p{Script=Han}/u.test(raw)
    ? fallback || translated : translated;
}

function taskUiMessage(file, statusLabel) {
  const fallback = file.status === "failed" ? describeError(file.error?.code).title
    : file.status === "running" ? stageText(file.stage) || statusLabel : statusLabel;
  return backendUiText(file.message || statusLabel, fallback);
}

// 冷启动 / 重连只允许有一条在跑：并发调用拿同一个 promise，否则"启动前就加进来
// 的视频"会被注册两遍，重连时还会和自动重连抢着 spawn。
function bootstrapBackend() {
  if (state.backend.bootstrapping) return state.backend.bootstrapping;
  state.backend.bootstrapping = bootstrapBackendOnce()
    .catch((error) => {
      // 走到这里说明是代码级异常（IPC 抛错等）：别让界面卡在"连接中"。
      state.backend.ready = false;
      state.backend.error = (error && error.message) || t("无法启动 OCR 后端");
      showToast(t("OCR 后端不可用，暂时无法识别字幕"));
    })
    .finally(() => {
      state.backend.bootstrapping = null;
      state.backend.connecting = false;
      updateBackendUi();
      // 方案 C：后端这一轮尘埃落定（成功读回字幕 / 失败降级）之后再定位，
      // 这样选中字幕与播放头都能一次到位。
      applyPendingUiPosition();
    });
  return state.backend.bootstrapping;
}

// 首次点"开始识别"时后端可能还没握上手（冷启动解压 / 杀软扫描要几秒）：
// 这一轮请求等着它起来，别让用户点了没反应。
async function ensureBackendReady() {
  if (state.backend.ready) return true;
  await bootstrapBackend();
  return state.backend.ready;
}

async function bootstrapBackendOnce() {
  state.backend.connecting = true;
  updateBackendUi();
  // 状态事件必须在握手之前接上：首次握手晚了、或者中途崩了，界面才收得到
  // ready / exited（事件流本身延迟到 connect() 里才真正接 IPC）。
  wireBackendEvents();

  let result;
  try {
    result = await window.ocrSession.connect();
  } catch (error) {
    result = { ok: false, error: (error && error.message) || t("无法启动 OCR 后端") };
  }
  state.backend.connecting = false;
  state.backend.hello = (result && result.hello) || null;
  state.backend.capabilities = (result && result.capabilities) || null;

  if (!result || !result.ok) {
    state.backend.ready = false;
    state.backend.error = (result && result.error) || t("无法启动 OCR 后端");
    // 上次会话里还没恢复的行要收尾：显示"正在恢复"会让人以为程序卡住了。
    downgradePendingRestores("backend-unavailable");
    updateBackendUi();
    showToast(t("OCR 后端不可用，暂时无法识别字幕"));
    return;
  }

  state.backend.ready = true;
  state.backend.everReady = true;
  state.backend.error = "";
  state.backend.interrupted = null;
  applyCapabilities(state.backend.capabilities);

  // 上次会话里的任务：先让后端把磁盘上的 SRT 只读读回来（不写盘、不排队），
  // 再登记剩下的行。
  await restoreSessionTasks();
  // 启动前就加进来的视频在后端没有记录，这里补一次注册。
  await registerTasks(state.files);
  // 断线期间改过的字幕这时补传（重连成功才算真的存住了）。
  await flushPendingCues();
  try {
    await syncQueueSnapshot();
  } catch (error) {
    /* 首次启动本来就没有任务，快照失败不影响使用 */
  }

  const hello = state.backend.hello || {};
  if (hello.modelsBundled === false) {
    // 让"安装包不完整"停在启动阶段，而不是识别到一半才炸。
    state.backend.ready = false;
    state.backend.error = t("安装包不完整：缺少 OCR 模型");
    showError({
      code: "E_MODELS_MISSING",
      message: state.backend.error,
      get detail() { return t("请重新下载完整安装包，或运行 build_sidecar_windows.bat 后重试"); }
    });
  }
  const preview = (state.backend.capabilities || {}).preview;
  if (preview && preview.transcodeAvailable === false) {
    showToast(t("缺少预览组件：mkv/avi 只能用系统播放器打开"));
  }
  updateBackendUi();
}

function handleBackendEvent(event, payload) {
  const data = payload || {};
  switch (event) {
    case "queue.started":
      state.queue.total = data.total || state.queue.total;
      state.queue.index = 0;
      // 新一轮的汇总重新计数：弹窗只对"这一轮的第一个失败"弹。
      state.queue.failures = 0;
      break;
    case "task.queued":
      applyTaskState(data.taskId, {
        status: "waiting",
        get message() { return t("排队中"); },
        queueIndex: data.queueIndex,
        queueTotal: data.queueTotal
      });
      break;
    case "task.started":
      state.queue.runningId = data.taskId;
      applyTaskState(data.taskId, {
        status: "running",
        progress: 0,
        get message() { return t("正在识别"); },
        error: null,
        queueIndex: data.queueIndex,
        queueTotal: data.queueTotal
      });
      break;
    case "task.progress":
      applyTaskState(data.taskId, {
        stage: data.stage,
        status: "running",
        progress: data.percent,
        overallPercent: data.overallPercent,
        message: data.message || stageText(data.stage) || t("正在识别"),
        queueIndex: data.queueIndex,
        queueTotal: data.queueTotal
      });
      break;
    case "task.completed":
      applyTaskState(data.taskId, {
        status: "completed",
        progress: 100,
        message: data.emptyResult ? t("未识别到字幕") : t("已完成"),
        error: null,
        // 一条都没识别到时后端不会写 SRT，这里要显式清掉上一遍的路径。
        outputPath: data.outputPath || null
      });
      clearWriteError(data.taskId);
      if (data.emptyResult) {
        showToast(t("这一遍没有识别到字幕，可以换个语言 / 阈值后重新识别"));
      }
      break;
    case "task.cues":
      applyCues(data);
      break;
    case "task.failed": {
      const failure = data.error || { code: "E_INTERNAL", get message() { return t("识别失败"); } };
      const file = findFile(data.taskId);
      applyTaskState(data.taskId, {
        status: "failed",
        progress: 0,
        message: failure.message || t("识别失败"),
        error: failure
      });
      // 看门狗判定卡死：后端紧接着会主动退出，主进程自动重连。
      if (failure.code === "E_OCR_STALLED") {
        state.backend.stalled = { taskId: data.taskId, message: failure.message };
      }
      // 取消是用户自己点的，不用再弹一遍。
      if (failure.code === "E_CANCELLED") break;
      // 队列里还有别的视频在跑 / 排队：这个失败不该打断整批。
      const queueContinues = state.files.some((item) => item.id !== data.taskId
        && (item.status === "running" || item.status === "waiting"));
      state.queue.failures = (state.queue.failures || 0) + 1;
      const first = state.queue.failures === 1;
      showError({
        code: failure.code,
        message: failure.message,
        detail: failure.detail,
        videoPath: file && file.path,
        source: first ? "task.failed" : "task.failed.again"
      }, { keepRunning: queueContinues, silent: !first });
      break;
    }
    case "task.cancelled":
      applyTaskState(data.taskId, {
        status: "cancelled",
        message: data.scope === "all" ? t("已停止全部") : t("已取消")
      });
      break;
    case "task.state":
      applyTaskState(data.taskId, {
        stage: data.stage,
        status: data.state,
        progress: data.progress,
        message: data.message || stageText(data.stage),
        outputPath: data.outputPath,
        // 上次跑出这份结果用的参数：会话快照要存它，重启后 task.restore 再播回后端。
        completedConfig: data.completedConfig,
        revision: data.revision
      });
      break;
    case "task.removed":
      // 删掉的正是当前在跑的那个：这一轮已经没有别的任务了，后端不会再发
      // queue.completed（它的 run_order 里已经没有这个 id），界面自己收尾，
      // 否则进度弹窗会一直挂着、弹窗里的"停止"还会指向一个不存在的任务。
      if (state.queue.runningId === data.taskId) {
        state.queue.runningId = null;
        state.running = false;
        hide(loadingModal);
      }
      removeFileLocally(data.taskId);
      break;
    case "queue.completed":
      finishQueue(data);
      break;
    case "video.previewProgress":
      applyPreviewProgress(data);
      break;
    case "video.previewReady":
      // 这里要 await 一次 IPC 拿 file:// URL，异常不能变成未处理的 Promise。
      applyPreviewReady(data).catch((error) => {
        console.error(t("预览就绪处理失败"), error);
      });
      break;
    case "video.previewFailed":
      applyPreviewFailed(data);
      break;
    default:
      break;
  }
}

function resolveTargets() {
  const pending = state.pendingIds
    .map((id) => state.files.find((file) => file.id === id))
    .filter(Boolean);
  if (pending.length) return pending;
  // 列表里已经有多个任务、这次又没导入新视频（"+新建任务"里直接点开始）：
  // 对整份列表跑一遍，让后端跳过已完成项、从第一个未完成的继续。
  if (state.files.length > 1) return state.files.slice();
  const current = getCurrentFile();
  if (current) return [current];
  return state.files.slice();
}

function findFile(taskId) {
  return state.files.find((file) => file.id === taskId) || null;
}

function applyTaskState(taskId, patch, options = {}) {
  const file = findFile(taskId);
  if (!file) return null;
  // 同一状态被事件和快照各推一次时，revision 小的一次直接丢掉。
  if (typeof patch.revision === "number" && patch.revision < file.revision) return file;
  const beforeSignature = sessionSignature(file);
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) continue;
    file[key] = patch[key];
  }
  file.progress = clampNumber(file.progress, 0, 100, 0);
  // 状态 / 输出路径这类要写进快照的字段变了才存盘：进度事件每 100ms 一次，
  // 不能跟着它写（sessionSignature 只认那几项）。
  if (sessionSignature(file) !== beforeSignature) persistSessionSoon();
  if (options.quiet) return file;

  // 运行中加入的视频会先变成"排队中"：它的状态事件不能把进度条顶回 0%。
  const isRunningTask = !state.queue.runningId || state.queue.runningId === taskId;
  if (isRunningTask && !loadingModal.classList.contains("hidden")) {
    updateLoadingModal({
      queueIndex: file.queueIndex || state.queue.index || 1,
      queueTotal: file.queueTotal || state.queue.total || 1,
      percent: file.progress,
      overallPercent: file.overallPercent,
      stage: file.stage,
      message: file.message
    });
  }
  scheduleFileRender();
  return file;
}

function applyCues(data) {
  const file = findFile(data.taskId);
  if (!file) return;
  if (data.state && data.state !== "failed") file.status = data.state;
  file.cues = (data.cues || []).map(normalizeCue);
  // 新一遍识别结果一到，旧的撤回历史就失效了（字幕 id 会被重新编号）。
  resetCueHistory(file);
  // 后端给的是权威内容：版本往前推一格，正在路上的那次回传就不会再回来改这个标记。
  file.cueRevision = (file.cueRevision || 0) + 1;
  file.dirty = false;
  file.activeCueId = file.cues[0] ? file.cues[0].id : null;
  file.message = t("已完成");
  if (file.id === state.currentFileId) {
    state.activeSubtitleId = file.activeCueId;
    refreshSubtitlesSafely();
  }
  persistSessionSoon();
  scheduleFileRender();
}

// 后端返回的时间值原样使用，不做吸附或归一化（SIDECAR_API.md 4.3）。
function normalizeCue(cue, index) {
  return {
    id: index + 1,
    startMs: Math.max(0, Math.round(Number(cue.startMs) || 0)),
    endMs: Math.max(0, Math.round(Number(cue.endMs) || 0)),
    text: String(cue.text === undefined || cue.text === null ? "" : cue.text),
    confidence: typeof cue.confidence === "number" ? cue.confidence : 1,
    fps: Number(cue.fps) || 0,
    startFrame: cue.startFrame === undefined ? null : cue.startFrame,
    endFrame: cue.endFrame === undefined ? null : cue.endFrame
  };
}

// 事件是高频的（progress 每 100ms 一次），合并到一帧里渲染。
function scheduleFileRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderFiles();
  });
}

// 用户正在输入时不要重建字幕列表，否则输入框会失焦。
function refreshSubtitlesSafely() {
  const active = document.activeElement;
  if (active && subtitleList.contains(active)) return;
  renderSubtitles();
  updateSubtitleOverlay();
}

async function syncQueueSnapshot() {
  const snapshot = await window.ocrSession.snapshot();
  state.queue.runningId = (snapshot && snapshot.running) || null;
  for (const task of (snapshot && snapshot.tasks) || []) {
    applyTaskState(task.taskId, {
      stage: task.stage,
      status: task.state,
      progress: task.progress,
      message: task.message || stageText(task.stage),
      outputPath: task.outputPath,
      error: task.error,
      revision: task.revision,
      // 断线重连后把"上次用的参数"也补齐：批量跳过靠的就是它。
      completedConfig: task.completedConfig
    }, { quiet: true });
  }
  renderFiles();
}

async function startRecognition() {
  hide(onboardingModal);
  if (state.files.length === 0) {
    showToast(t("请先选择视频文件"));
    showSetup();
    return;
  }

  readSettingsFromForm();
  const targets = resolveTargets();
  state.pendingIds = [];
  state.pendingVideos = [];
  state.setupSelectedIds.clear();
  updateVideoPickLabel();
  renderPendingList();

  // 进度弹窗已退休：新建任务后统一落到文件管理页看行内进度；单视频也先把这一行选好，
  // 行里点「校对」就进校对页。
  if (targets.length > 1) {
    showView("files");
    await enqueueBackend(targets, true);
    return;
  }
  const target = targets[0];
  selectFile(target.id);
  showView("files");
  await enqueueBackend([target], false);
}

// 行内"开始"：只跑这一个视频，和在新任务弹窗里点开始是同一条路径。
async function startFile(file) {
  state.pendingIds = [file.id];
  state.pendingVideos = [];
  await enqueueBackend([file], false);
}

// 等后端起来的这几秒在行上给个提示（进度弹窗退休后，界面不能看着像没反应）。
// 返回撤销函数：这一轮被作废 / 后端没起来时把提示收回去，别留一条假排队。
function markBackendWait(targets) {
  const touched = [];
  targets.forEach((file) => {
    if (file.status === "completed" || file.status === "modified") return;
    touched.push({ file, status: file.status, message: file.message, progress: file.progress });
    file.status = "waiting";
    file.message = t("正在启动 OCR 后端…");
  });
  renderFiles();
  return () => {
    touched.forEach((item) => {
      item.file.status = item.status;
      item.file.message = item.message;
      item.file.progress = item.progress;
    });
    renderFiles();
  };
}

async function enqueueBackend(targets, batch) {
  // 进度弹窗不再由流程弹出（实现留着）：先把这一轮的队列状态摆好，进度看文件管理页。
  showLoadingModal(targets);
  const token = (state.runToken || 0) + 1;
  state.runToken = token;
  // 新的一轮：汇总里的失败计数从 0 开始（决定要不要弹错误框）。
  state.queue.failures = 0;
  if (!state.backend.ready) {
    // 弹窗没了，等待提示得落到行上：冷启动这几秒里界面不能看着像没反应。
    $("#loadingSub").textContent = t("正在启动 OCR 后端…");
    const undoWaitHint = markBackendWait(targets);
    const ready = await ensureBackendReady();
    // 等待期间用户点了停止（或又开了一轮）：这一轮作废，提示也要收回，别偷偷开跑。
    if (token !== state.runToken) {
      undoWaitHint();
      return;
    }
    if (!ready) {
      hide(loadingModal);
      undoWaitHint();
      showError({
        code: "E_BACKEND_NOT_READY",
        message: state.backend.error || t("OCR 后端尚未就绪"),
        get detail() { return t("请确认 SubtitleSidecar.exe 存在且能启动，然后重新点一次「开始识别」"); }
      });
      return;
    }
    // 后端起来之后才有真实的 capabilities，这时再把界面上的参数校一遍。
    readSettingsFromForm();
  }

  // 等待后端期间用户可能把视频删了：删除会把它从列表里摘掉，这一轮只能对还在列表
  // 里的任务生效。否则已经删掉的视频照样会被识别，进度窗口还停在它的名字上（事件
  // 因为找不到这一行全被丢掉）。
  const live = targets.filter((file) => state.files.includes(file));
  if (!live.length) {
    hide(loadingModal);
    renderFiles();
    return;
  }

  live.forEach((file) => {
    if (file.status === "completed" || file.status === "modified") return;
    file.status = "waiting";
    file.progress = 0;
    file.error = null;
    file.message = t("排队中");
  });
  renderFiles();

  try {
    await registerTasks(live);
    const options = buildOptions();
    if (batch) {
      const result = await window.ocrSession.runQueue(live.map((file) => file.id), options);
    const started = (result && result.started) || 0;
    const skipped = (result && result.skipped) || 0;
    const stopping = (result && result.stopping) || 0;
    if (!started && stopping) {
      // 上一次的停止还没收尾（后端把它算成"跳过"）：这时点开始什么都启动不了，
      // 得说清楚是等一下，而不是"都已经有结果了"。
      hide(loadingModal);
      showToast(t("{0} 个视频还在停止中，稍等一下再点开始", [stopping]));
    } else if (skipped && !started) {
      hide(loadingModal);
      showToast(t("这 {0} 个视频已经有结果，无需重跑", [skipped]));
    } else if (started && stopping) {
      showToast(t("已开始 {0} 个；另有 {1} 个还在停止中，稍后再点一次开始就会补跑", [started, stopping]));
    } else if (skipped) {
      showToast(t("已开始 {0} 个，跳过不需要重跑的 {1} 个", [started, skipped]));
    }
    } else {
      await window.ocrSession.start(live[0].id, live[0].path, options);
    }
  } catch (error) {
    hide(loadingModal);
    renderFiles();
    showError({
      code: error.code || "E_INTERNAL",
      message: error.message,
      detail: error.detail,
      videoPath: live[0] && live[0].path
    });
  }
}

// 进度弹窗不再由流程弹出（代码与样式都留着，随时能改回来）：进度看文件管理页的行内
// 进度环 / 百分比 / 阶段文案。这里只负责填内容、摆好这一轮的队列状态。
function showLoadingModal(targets) {
  state.queue.total = targets.length;
  state.queue.index = 0;
  setProgress(0);
  $("#loadingTitle").textContent = targets.length > 1 ? t("正在批量识别字幕…") : t("正在识别字幕…");
  $("#loadingDetail").textContent = targets.length > 1
    ? t("共 {0} 个视频", [targets.length])
    : (targets[0] && targets[0].name) || "";
  $("#loadingSub").textContent = t("正在加载模型…");
}

function updateLoadingModal(payload) {
  if (loadingModal.classList.contains("hidden")) return;
  state.queue.index = payload.queueIndex || 1;
  state.queue.total = payload.queueTotal || state.queue.total || 1;
  const percent = payload.percent || 0;
  // 批量时进度环用整批的进度（后端按时长加权算好的 overallPercent），否则每换一个
  // 视频都会从 0% 重来，看起来像"又从第一个开始"。文案里两个数都给出来。
  const overall = typeof payload.overallPercent === "number" ? payload.overallPercent : percent;
  setProgress(state.queue.total > 1 ? overall : percent);
  $("#loadingDetail").textContent = state.queue.total > 1
    ? t("第 {0} 个视频 · 共 {1} 个 · 本条 {2}%", [state.queue.index, state.queue.total, percent])
    : t("第 {0} 个视频 · 共 {1} 个 · {2}%", [state.queue.index, state.queue.total, percent]);
  $("#loadingSub").textContent = backendUiText(payload.message || "", stageText(payload.stage) || t("正在识别"));
}

function setProgress(value) {
  const percent = clampNumber(value, 0, 100, 0);
  $("#progressValue").textContent = `${Math.round(percent)}%`;
  $("#linearProgress").style.width = `${percent}%`;
  progressCircle.style.strokeDashoffset = `${circumference - (percent / 100) * circumference}`;
}

function finishQueue(summary) {
  state.queue.runningId = null;
  state.running = false;
  hide(loadingModal);
  updateSubtitleOverlay();
  renderFiles();
  renderSubtitles();
  if (!summary) return;
  const { completed = 0, failed = 0, cancelled = 0 } = summary;
  // 单个视频跑完不必弹汇总，只有批量或有失败/取消时才值得打断用户。
  if (failed || cancelled || completed > 1) {
    showToast(t("识别结束：完成 {0} · 失败 {1} · 取消 {2}", [completed, failed, cancelled]));
  }
}

// 单个停止：正在跑的会被取消并让队列继续，排队中的直接移出队列。
async function cancelRecognition() {
  // 还在等后端起来的这一轮也要作废，否则点了中断它照样会开跑。
  state.runToken = (state.runToken || 0) + 1;
  if (!state.backend.ready) {
    hide(loadingModal);
    renderFiles();
    return;
  }
  // 批量跑的时候"当前选中的视频"未必在队列里（用户可能正看着一个已完成的视频），
  // 所以先找真正在跑的那条、再找还在排队的；都没有就什么都不停，别对已完成的任务
  // 发一次空操作还回报"已停止"。
  const active = state.files.find((file) => file.status === "running")
    || state.files.find((file) => file.status === "waiting");
  const targetId = state.queue.runningId || (active && active.id) || null;
  if (!targetId) {
    hide(loadingModal);
    return;
  }
  try {
    await window.ocrSession.cancelTask(targetId);
    showToast(t("已停止该视频，其余任务继续"));
  } catch (error) {
    showToast(t("停止失败：{0}", [error.message]));
  }
}

// 批量停止：清空整个队列，正在跑的那个也一起停。
async function stopBatch() {
  // 队列还没建起来时后端不知道要停什么，这里只作废界面上这一轮。
  state.runToken = (state.runToken || 0) + 1;
  if (!state.backend.ready) {
    hide(loadingModal);
    renderFiles();
    return;
  }
  try {
    const result = await window.ocrSession.cancelAll();
    showToast(t("已停止全部任务（{0} 个）", [result.cancelled]));
    state.queue.runningId = null;
    hide(loadingModal);
  } catch (error) {
    showToast(t("停止失败：{0}", [error.message]));
  }
  renderFiles();
}

// 错误码 → 弹窗标题与处理建议（SIDECAR_API.md §7，外加前端自有的
// E_BACKEND_EXITED）。未知码回落到通用文案：原始 code / message / detail
// 仍然原样显示，方便对着日志排查。
const ERROR_CATALOG = {
  E_BACKEND_NOT_READY: {
    get title() { return t("OCR 后端没有就绪"); },
    get hint() { return t("确认安装包里的 SubtitleSidecar.exe 能启动，点下面的「重新连接」再试一次。"); },
    retry: true
  },
  E_PROTOCOL_VERSION: {
    get title() { return t("前后端版本不一致"); },
    get hint() { return t("两侧协议对不上，需要重装同一个版本的安装包。"); }
  },
  E_MODELS_MISSING: {
    get title() { return t("安装包不完整"); },
    get hint() { return t("缺少 OCR 模型文件，请重新下载完整安装包。"); }
  },
  E_VIDEO_NOT_FOUND: {
    get title() { return t("找不到视频文件"); },
    get hint() { return t("文件可能被移动、改名或删除，重新选中它之后可以再试。"); }
  },
  E_VIDEO_DECODE: {
    get title() { return t("视频解码失败"); },
    get hint() { return t("文件损坏或编码不受支持（avi 较常见），可以先转成 mp4 再识别。"); }
  },
  E_VIDEO_UNSUPPORTED: {
    get title() { return t("这不是可识别的视频"); },
    get hint() { return t("只支持 mp4 / mov / mkv / avi / webm；拖进来的如果是指向别处的快捷方式或文件夹，请换成视频文件本身。"); }
  },
  E_UNSUPPORTED_LANGUAGE: {
    get title() { return t("不支持这个语言"); },
    get hint() { return t("换成中文或英文（下拉里带中文名的语言都可用）再试一次。"); }
  },
  E_INVALID_OPTIONS: {
    get title() { return t("识别参数不合法"); },
    get hint() { return t("点设置里的「恢复默认设置」，再重新点开始识别。"); }
  },
  E_OCR_RUNTIME: {
    get title() { return t("识别引擎出错"); },
    get hint() { return t("这一轮没能跑完，日志里有完整堆栈；重新识别或重新安装包。"); }
  },
  E_OCR_STALLED: {
    get title() { return t("识别卡住了"); },
    hint: t("后端在加载模型或处理视频时长时间没有进展（常见于安全软件拦截、老 CPU、")
      + t("共享盘）。后端已经自动重启，点「重新识别」再跑一遍即可。"),
    retry: true
  },
  E_OUTPUT_WRITE: {
    get title() { return t("SRT 写不进磁盘"); },
    get hint() { return t("输出目录被占用或没有写权限，换一个目录后重新导出。"); }
  },
  E_CANCELLED: {
    get title() { return t("任务已取消"); },
    get hint() { return t("这一轮按停止收尾，字幕没有改动。"); }
  },
  E_TASK_NOT_FOUND: {
    get title() { return t("任务状态对不上"); },
    get hint() { return t("界面和后端记录漂移了，重开应用会重新同步一次任务列表。"); }
  },
  E_TASK_BUSY: {
    get title() { return t("视频正在识别"); },
    get hint() { return t("这份字幕马上会被识别结果替换，等这一遍跑完再改。"); }
  },
  E_PREVIEW_UNAVAILABLE: {
    get title() { return t("无法在应用内预览"); },
    get hint() { return t("识别和校对不受影响，可以定位时间后用系统播放器打开。"); }
  },
  E_PREVIEW_TRANSCODE: {
    get title() { return t("预览转码失败"); },
    get hint() { return t("源文件可能损坏或磁盘空间不足；识别照常可以继续。"); }
  },
  E_BACKEND_EXITED: {
    get title() { return t("OCR 后端已退出"); },
    get hint() { return t("正在跑的任务被打断了，需要重新识别；点下面的「重新连接」可以拉起后端。"); },
    retry: true
  },
  E_INTERNAL: {
    get title() { return t("识别未能完成"); },
    get hint() { return t("把诊断信息和日志一起发给我们，会有人尽快跟进。"); }
  }
};

const ERROR_FALLBACK = {
  get title() { return t("识别未能完成"); },
  get hint() { return t("把诊断信息和日志一起发给我们，会有人尽快跟进。"); }
};

function describeError(code) {
  return ERROR_CATALOG[code] || ERROR_FALLBACK;
}

// 错误落盘：主进程写 <userData>/logs/error.log（详细报错 + 错误码）。
// 日志写不进去也不能影响弹窗本身，所以这里一律吞掉异常。
async function reportError(payload) {
  try {
    const result = await window.subtitleApp?.logError?.(payload);
    return (result && result.path) || "";
  } catch (error) {
    return "";
  }
}

let lastDisplayedError = null;

function updateErrorLabels(error) {
  const code = error.code || "E_INTERNAL";
  const entry = describeError(code);
  $("#errorTitle").textContent = entry.title;
  $("#errorHint").textContent = entry.hint || "";
  const lines = [`${code} · ${uiI18n.message(error.message || entry.title)}`];
  if (error.videoPath) lines.push(error.videoPath);
  $("#errorCode").textContent = lines.join("\n");
}

function showError(info, options = {}) {
  const error = typeof info === "string" ? { message: info } : (info || {});
  const code = error.code || "E_INTERNAL";
  const entry = describeError(code);
  const message = error.message || entry.title;
  // 后端 stderr 的尾部由主进程补上，日志里才有完整现场。
  const logged = options.skipLog ? Promise.resolve("") : reportError({
    code,
    message,
    detail: error.detail || "",
    videoPath: error.videoPath || "",
    outputPath: error.outputPath || "",
    source: options.source || error.source || "ui"
  });
  // 批量里只弹第一个失败：每个都弹就没人看得了，也没法继续用界面。
  if (options.silent) return;
  lastDisplayedError = error;
  // 后面还有任务在跑 / 排队时不要收进度窗口，这一轮剩下的进度还得有地方看。
  if (!options.keepRunning) {
    state.running = false;
    hide(loadingModal);
  }
  $("#errorTitle").textContent = entry.title;
  $("#errorHint").textContent = entry.hint || "";
  // 后端这类错误顺手给一个重连入口，别让用户自己去找。
  $("#retryErrorButton").classList.toggle("hidden", !entry.retry);
  const lines = [`${code} · ${message}`];
  if (error.videoPath) lines.push(error.videoPath);
  $("#errorCode").textContent = lines.join("\n");
  updateErrorLabels(error);
  $("#errorDetail").textContent = error.detail || "";
  $("#errorLogPath").textContent = "";
  errorModal.dataset.detail = [code, message, error.detail, error.videoPath]
    .filter(Boolean)
    .join(" | ");
  show(errorModal);
  logged.then((logPath) => {
    if (!logPath || errorModal.classList.contains("hidden")) return;
    $("#errorLogPath").textContent = t("日志：{0}", [logPath]);
  }).catch(() => {});
}

// 错都错了，别让用户自己翻目录：直接打开日志所在位置。
async function revealErrorLog() {
  try {
    const target = await window.subtitleApp?.revealErrorLog?.();
    if (!target) showToast(t("没有找到日志文件"));
  } catch (error) {
    showToast(t("打开日志位置失败：{0}", [error.message]));
  }
}

function copyError() {
  const lines = [errorModal.dataset.detail || $("#errorCode").textContent];
  const logLine = $("#errorLogPath").textContent;
  if (logLine) lines.push(logLine);
  navigator.clipboard?.writeText(lines.join("\n"));
  showToast(t("诊断信息已复制，发给技术支持即可快速定位问题"));
}

function updateEmptyStates() {
  const hasFile = Boolean(getCurrentFile());
  $("#emptyPlayer").classList.toggle("hidden", hasFile);
  posterState.classList.toggle("hidden", !hasFile || Boolean(videoPlayer.getAttribute("src")));
  updatePlayerControls();
}

function selectFile(id) {
  const file = state.files.find((item) => item.id === id);
  if (!file) return;
  // 切走之前先把没落盘的编辑回传给"被改的那个视频"，否则回传会认成新选中的视频。
  flushPendingCues();
  if (state.currentFileId && state.currentFileId !== id) {
    cancelPreviewJob(findFile(state.currentFileId));
  }
  state.currentFileId = file.id;
  state.activeSubtitleId = file.activeCueId || file.cues[0]?.id || null;
  $("#currentFileName").textContent = file.name;
  hidePreviewNotice();
  hideStill();
  loadVideoForFile(file);
  updateEmptyStates();
  renderSubtitles();
  renderFiles();
  updateSubtitleOverlay();
}

// 选择视频时顺便问一次后端：能直接播就直接播，mkv/avi 先准备预览。
async function loadVideoForFile(file) {
  if (!file) return;
  // 已经知道播不了的（例如用户上次已经看过提示），直接把提示挂回去。
  if (file.previewUnavailable) {
    showPreviewFallback(file, file.previewMessage || PREVIEW_FALLBACK_TEXT, {
      allowPrepare: Boolean(file.previewCanPrepare)
    });
    return;
  }
  const source = file.previewPath || file.url;
  if (source) {
    if (videoPlayer.getAttribute("src") !== source) videoPlayer.src = source;
    updatePlayerControls();
    commitPendingSeek(file);
    return;
  }
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  if (!state.backend.ready || !file.path) return;
  let info;
  try {
    info = await window.ocrSession.probe(file.path);
  } catch (error) {
    showPreviewFallback(file, t("无法读取视频信息：{0}", [error.message]),
      { transient: true });
    return;
  }
  file.durationMs = info.durationMs || 0;
  file.fps = info.fps || 0;
  if (info.previewPlayable) {
    file.previewPath = await fileUrl(file.path);
    file.previewLocalPath = file.path;
    if (state.currentFileId === file.id) videoPlayer.src = file.previewPath;
    commitPendingSeek(file);
    return;
  }
  // 长视频先问一次：整片转码可能要几十分钟，不能默默排队（SIDECAR_API.md 11.6）。
  if (file.durationMs >= LONG_VIDEO_MS) {
    showPreviewFallback(file, t("这个视频要重新封装后才能内嵌播放，长视频可能需要几十秒到几分钟"), {
      allowPrepare: true
    });
    return;
  }
  await preparePreviewFor(file);
}

async function fileUrl(filePath) {
  if (window.subtitleApp?.toFileUrl) return window.subtitleApp.toFileUrl(filePath);
  return `file://${String(filePath).replace(/\\/g, "/")}`;
}

// ------------------------------------------------------------ mkv/avi 预览
const PREVIEW_FALLBACK_TEXT = t("这个视频无法在应用内播放");

function updatePreviewNotice(file, title, text, options) {
  if (!file || state.currentFileId !== file.id) return;
  const settings = options || {};
  $("#previewNoticeTitle").textContent = title;
  $("#previewNoticeText").textContent = text;
  $("#previewPrepareButton").classList.toggle("hidden", !settings.allowPrepare);
  show($("#previewNotice"));
}

function hidePreviewNotice() {
  const notice = $("#previewNotice");
  if (notice) hide(notice);
}

function showPreviewFallback(file, reason, options) {
  if (!file) return;
  const settings = options || {};
  const allowPrepare = Boolean(settings.allowPrepare);
  // ``transient``：探测失败 / 后端还没起来这类临时问题，不能记进 file。
  // 记下来之后重新选中这个视频会在 loadVideoForFile 顶部直接 return，
  // 本进程内再也不会重新探测，「准备预览」也永远不再出现。
  if (!settings.transient) {
    file.previewUnavailable = true;
    file.previewMessage = reason;
    file.previewCanPrepare = allowPrepare;
  }
  if (state.currentFileId !== file.id) return;
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  posterState.classList.remove("hidden");
  updatePlayerControls();
  updatePreviewNotice(file, t("无法在应用内预览"), t("{0}。识别与校对不受影响，可以定位到字幕时间后用系统播放器打开。", [reason]), {
    allowPrepare
  });
}

// 收掉一份还在准备的预览：切走视频 / 删除视频时调用。
// 不取消的话后台还在转码（后端同时只跑一个预览，它还会挡住后面排队的），
// 而用户已经看不到这条进度了。
async function cancelPreviewJob(file) {
  if (!file) return;
  const jobId = file.previewJobId;
  if (!jobId) return;
  file.previewJobId = null;
  if (state.preview.jobId === jobId) {
    state.preview.jobId = null;
    state.preview.targetId = null;
  }
  if (!state.backend.ready) return;
  try {
    await window.ocrSession.cancelPreview(jobId);
  } catch (error) {
    /* 取消失败不值得打断用户：这一份跑完就结束了 */
  }
}

// 「准备预览」：mkv/avi 先重封装成缓存 MP4，能直接播时后端会同步返回。
async function preparePreviewFor(file, force) {
  if (!file || !file.path) return;
  const preview = (state.backend.capabilities || {}).preview;
  if (preview && preview.transcodeAvailable === false) {
    showPreviewFallback(file, t("当前安装包缺少预览组件，请改用系统播放器"));
    return;
  }
  if (!state.backend.ready) {
    showPreviewFallback(file, t("OCR 后端尚未就绪，暂时无法准备预览"),
      { transient: true, allowPrepare: true });
    return;
  }
  if (file.previewJobId) return;
  state.preview.targetId = file.id;
  updatePreviewNotice(file, t("正在准备预览…"), t("正在重新封装为 MP4，完成后会自动播放"), {});
  try {
    const result = await window.ocrSession.preparePreview(file.path, Boolean(force));
    if (result && result.state === "ready") {
      await applyPreviewReady({
        jobId: null,
        videoPath: file.path,
        previewPath: result.previewPath,
        mode: result.mode
      });
      return;
    }
    if (result && result.jobId) {
      file.previewJobId = result.jobId;
      state.preview.jobId = result.jobId;
    }
  } catch (error) {
    if (error.code === "E_CANCELLED") {
      hidePreviewNotice();
      return;
    }
    showPreviewFallback(file, t("预览准备失败：{0}", [error.message]), { allowPrepare: true });
  }
}

function findPreviewFile(payload) {
  const data = payload || {};
  if (data.jobId) {
    const byJob = state.files.find((file) => file.previewJobId === data.jobId);
    if (byJob) return byJob;
  }
  if (data.videoPath) {
    return state.files.find((file) => file.path === data.videoPath) || null;
  }
  return null;
}

function applyPreviewProgress(payload) {
  const file = findPreviewFile(payload);
  if (!file) return;
  // 排队中的任务只有位次没有百分比（后端同时只跑一个预览）。
  const text = payload.queuePosition
    ? backendUiText(payload.message || t("排队等待中"), t("排队等待中"))
    : `${backendUiText(payload.message || t("正在重新封装"), t("正在重新封装"))} ${Math.round(payload.percent || 0)}%`;
  updatePreviewNotice(file, t("正在准备预览…"), text, {});
}

async function applyPreviewReady(payload) {
  const file = findPreviewFile(payload) || findFile(state.preview.targetId);
  if (!file) return;
  file.previewJobId = null;
  file.previewUnavailable = false;
  file.previewMessage = "";
  file.previewCanPrepare = false;
  state.preview.jobId = null;
  state.preview.targetId = null;
  file.previewLocalPath = payload.previewPath || file.path;
  file.previewPath = await fileUrl(file.previewLocalPath);
  if (state.currentFileId === file.id) {
    hidePreviewNotice();
    videoPlayer.src = file.previewPath;
    updatePlayerControls();
    // 上次的播放头在等这一刻：mkv/avi 预览就绪后再补一次定位。
    commitPendingSeek(file);
  }
  showToast(payload.mode === "transcode" ? t("预览转码完成") : t("预览已就绪"));
}

function applyPreviewFailed(payload) {
  const file = findPreviewFile(payload);
  if (!file) return;
  file.previewJobId = null;
  state.preview.jobId = null;
  state.preview.targetId = null;
  const error = payload.error || {};
  if (error.code === "E_CANCELLED") {
    hidePreviewNotice();
    return;
  }
  showPreviewFallback(file, t("预览准备失败：{0}", [error.message || t("未知原因")]), {
    allowPrepare: true
  });
}

function getCurrentFile() {
  return state.files.find((item) => item.id === state.currentFileId) || null;
}

function getCurrentSubtitles() {
  return getCurrentFile()?.cues || [];
}

function renderFiles() {
  updateEmptyStates();
  const query = $("#fileSearchInput")?.value.trim().toLowerCase() || "";
  const rows = state.files.filter((file) => !query || file.name.toLowerCase().includes(query));
  state.selectedFileIds = new Set([...state.selectedFileIds].filter((id) => state.files.some((file) => file.id === id)));
  const doneCount = state.files.filter(
    (file) => file.status === "completed" || file.status === "modified").length;
  $("#fileCount").textContent = `(${state.files.length})`;
  $("#fileSummary").textContent = state.files.length
    ? t("{0} 个完成 · {1} 个总任务", [doneCount, state.files.length])
    : t("管理批量视频与处理状态");
  fileList.innerHTML = "";

  if (rows.length === 0) {
    fileList.innerHTML = `
      <div class="empty-state">
        <strong>${t("暂无视频任务")}</strong>
        <span>${t("点击“添加视频”导入单个或批量文件。")}</span>
      </div>
    `;
    updateSelectionControls();
    return;
  }

  rows.forEach((file, index) => {
    const row = document.createElement("div");
    row.className = `file-row${file.id === state.currentFileId ? " active" : ""}`;
    // 正在恢复的行不显示"已完成"：字幕还没从磁盘读回来。
    const statusLabel = file.restoring ? t("正在恢复") : statusText(file.status);
    const statusKind = file.restoring ? "processing" : statusBadge(file.status);
    row.innerHTML = `
      <input class="file-checkbox" type="checkbox" aria-label="${t("选择 ")}${escapeHtml(file.name)}" ${state.selectedFileIds.has(file.id) ? "checked" : ""} />
      <span class="file-index">${index + 1}</span>
      <div class="file-info">
        <strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong>
        <span>${escapeHtml(taskUiMessage(file, statusLabel))}${file.outputPath && !file.needsRelink ? t(" · 已写入 SRT") : ""}${file.writeError ? t(" · <b class=\"write-warning\">写盘失败，改动只在本程序内</b>") : file.dirty ? t(" · <b class=\"unsaved-hint\">改动未保存</b>") : ""}${file.restoreNotice ? ` · <b class="restore-warning">${escapeHtml(uiI18n.message(file.restoreNotice))}</b>` : ""}</span>
      </div>
      <div class="file-progress">
        <span style="width:${clampNumber(file.progress, 0, 100, 0)}%"></span>
      </div>
      <span class="status-badge ${statusKind}">${escapeHtml(statusLabel)}</span>
      <div class="file-actions">
        <button class="ghost-btn compact proofread-file${file.needsRelink ? " hidden" : ""}" type="button">${t("校对")}</button>
        <button class="ghost-btn compact relink-file${file.needsRelink ? "" : " hidden"}" type="button">${t("重新选择")}</button>
        <button class="ghost-btn compact start-file${file.status === "idle" && !file.needsRelink ? "" : " hidden"}" type="button">${t("开始")}</button>
        <button class="ghost-btn compact stop-file${file.status === "running" || file.status === "waiting" ? "" : " hidden"}" type="button">${t("停止")}</button>
        <button class="ghost-btn compact retry-file${file.status === "cancelled" || file.status === "failed" || file.status === "modified" ? "" : " hidden"}" type="button">${t("重新识别")}</button>
        <button class="icon-btn delete-file" type="button" title="${t("删除")}">
          <svg class="svg-icon small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
        </button>
      </div>
    `;

    row.querySelector(".file-checkbox").addEventListener("change", (event) => {
      event.stopPropagation();
      if (event.target.checked) state.selectedFileIds.add(file.id);
      else state.selectedFileIds.delete(file.id);
      updateSelectionControls();
    });
    row.querySelector(".proofread-file").addEventListener("click", () => {
      selectFile(file.id);
      showView("proofread");
    });
    row.querySelector(".delete-file").addEventListener("click", () => deleteFile(file.id));
    row.querySelector(".start-file").addEventListener("click", async (event) => {
      event.stopPropagation();
      await startFile(file);
    });
    row.querySelector(".relink-file").addEventListener("click", async (event) => {
      event.stopPropagation();
      await relinkFile(file);
    });
    row.querySelector(".stop-file").addEventListener("click", async (event) => {
      event.stopPropagation();
      await cancelFile(file);
    });
    row.querySelector(".retry-file").addEventListener("click", async (event) => {
      event.stopPropagation();
      await requeueFile(file);
    });
    row.addEventListener("dblclick", () => {
      selectFile(file.id);
      showView("proofread");
    });
    fileList.appendChild(row);
  });
  updateSelectionControls();
}

// 视频被删掉/停止时，属于它的待回传编辑也就没有意义了。
function dropPendingCues(id) {
  if (state.pushTimer && state.pushTargetId === id) {
    clearTimeout(state.pushTimer);
    state.pushTimer = null;
    state.pushTargetId = null;
  }
}

// 删视频是不可逆的（后端任务会被摘掉、正在跑的一起取消），先问一句。
// 对话框在主进程，取不到（浏览器预览 / 老版本）就按原来的行为直接删。
async function confirmDeleteFiles(message, detail) {
  if (!window.subtitleApp?.confirmAction) return true;
  try {
    return (await window.subtitleApp.confirmAction({ message, detail })) !== false;
  } catch (error) {
    return true;
  }
}

async function deleteFile(id) {
  const file = findFile(id);
  if (!file) return;
  const ok = await confirmDeleteFiles(
    t("确定删除「{0}」？", [file.name]),
    t("正在识别 / 排队的任务会被一并取消。已经写出的 SRT 文件不会被删除。"));
  if (!ok) return;
  // 运行中的任务先在后端取消，否则它会继续占着队列。
  dropPendingCues(id);
  cancelPreviewJob(file);
  window.ocrSession?.removeTask(id).catch(() => {});
  removeFileLocally(id);
}

function resetPlayer() {
  $("#currentFileName").textContent = t("尚未选择视频");
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  posterState.classList.remove("hidden");
  hidePreviewNotice();
  hideStill();
  updatePlayerControls();
}

// 只动界面状态；队列侧的删除由调用方通过 task.remove 完成。
function removeFileLocally(id) {
  if (!state.files.some((file) => file.id === id)) return;
  state.selectedFileIds.delete(id);
  state.files = state.files.filter((file) => file.id !== id);
  // 删掉的视频不能再算进"这次要跑哪些"。
  state.pendingIds = state.pendingIds.filter((pendingId) => pendingId !== id);
  state.setupSelectedIds.delete(id);
  updateVideoPickLabel();
  renderPendingList();
  if (state.currentFileId === id) {
    state.currentFileId = state.files[0] ? state.files[0].id : null;
    if (state.currentFileId) selectFile(state.currentFileId);
    else resetPlayer();
  }
  renderFiles();
  renderSubtitles();
  // 删掉的行不能留在快照里：立刻写，别等防抖（否则关窗前删的行会复活）。
  persistSessionNow();
  // 方案 C：删掉的正好是当前行时，UI_KEY 里"上次的视频"也得跟着换。
  persistUi();
}

function toggleSelectAllFiles(event) {
  const query = $("#fileSearchInput")?.value.trim().toLowerCase() || "";
  const visible = state.files.filter((file) => !query || file.name.toLowerCase().includes(query));
  if (event.target.checked) {
    visible.forEach((file) => state.selectedFileIds.add(file.id));
  } else {
    visible.forEach((file) => state.selectedFileIds.delete(file.id));
  }
  renderFiles();
}

async function deleteSelectedFiles() {
  if (state.selectedFileIds.size === 0) {
    showToast(t("请先选择要删除的视频"));
    return;
  }
  const ids = new Set(state.selectedFileIds);
  const ok = await confirmDeleteFiles(
    t("确定删除选中的 {0} 个视频任务？", [ids.size]),
    t("正在识别 / 排队的任务会被一并取消。已经写出的 SRT 文件不会被删除。"));
  if (!ok) return;
  ids.forEach((id) => {
    dropPendingCues(id);
    cancelPreviewJob(findFile(id));
    window.ocrSession?.removeTask(id).catch(() => {});
  });
  state.selectedFileIds.clear();
  state.files = state.files.filter((file) => !ids.has(file.id));
  if (state.currentFileId && ids.has(state.currentFileId)) {
    state.currentFileId = state.files[0] ? state.files[0].id : null;
    if (state.currentFileId) selectFile(state.currentFileId);
    else resetPlayer();
  }
  renderFiles();
  renderSubtitles();
  showToast(t("已删除选中的视频"));
}

function updateSelectionControls() {
  const checkbox = $("#selectAllFilesCheckbox");
  const query = $("#fileSearchInput")?.value.trim().toLowerCase() || "";
  const visible = state.files.filter((file) => !query || file.name.toLowerCase().includes(query));
  const selectedVisible = visible.filter((file) => state.selectedFileIds.has(file.id)).length;
  checkbox.checked = visible.length > 0 && selectedVisible === visible.length;
  checkbox.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  $("#batchDeleteButton").disabled = state.selectedFileIds.size === 0;
}

function statusText(status) {
  return (STATUS_META[status] || STATUS_META.idle).text;
}

// 停单个：后端的语义是"运行中就取消并继续下一个，排队中就移出队列"。
async function cancelFile(file) {
  if (!file) return;
  if (!state.backend.ready) {
    showToast(t("OCR 后端不可用"));
    return;
  }
  try {
    await window.ocrSession.cancelTask(file.id);
    showToast(t("已停止该视频，其余任务继续"));
  } catch (error) {
    showToast(t("停止失败：{0}", [error.message]));
  }
}

// 重新识别：排到队尾再跑，不打乱正在进行的批量任务。
async function requeueFile(file) {
  if (!file) return;
  if (!state.backend.ready) {
    showToast(t("OCR 后端不可用，无法重新识别"));
    return;
  }
  try {
    await window.ocrSession.requeue(file.id, file.path);
    showToast(t("已排到队尾"));
  } catch (error) {
    showToast(t("重新识别失败：{0}", [error.message]));
  }
}

function statusBadge(status) {
  return (STATUS_META[status] || STATUS_META.idle).badge;
}

function renderSubtitles() {
  const query = $("#searchInput").value.trim();
  const file = getCurrentFile();
  // 列表顺序就是 SRT 顺序，回传后端也按这个顺序写盘。
  const cues = file ? sortCues(file.cues) : [];
  renderTimeline(cues);
  const order = new Map(cues.map((item, position) => [item.id, position]));
  const rows = cues.filter((item) => {
    if (!query) return true;
    return item.text.includes(query)
      || ocrSession.formatTimestamp(item.startMs).includes(query)
      || ocrSession.formatTimestamp(item.endMs).includes(query);
  });
  $("#subtitleCount").textContent = `(${cues.length})`;
  subtitleList.innerHTML = "";

  if (rows.length === 0) {
    const empty = cues.length === 0
      ? `
        <div class="brand-mark glow"><span></span></div>
        <strong>${t("字幕列表为空")}</strong>
        <span>${t("识别完成后显示在这里")}</span>
      `
      : `
        <span class="no-match">${t("没有匹配的字幕")}</span>
      `;
    subtitleList.innerHTML = `<div class="subtitle-empty">${empty}</div>`;
    return;
  }

  rows.forEach((item) => {
    const position = order.get(item.id);
    const isLast = position === cues.length - 1;
    // 只有识别完成（或已修改）的视频才有可校对的内容：别的时候改了就丢，
    // 所以直接把控件锁上，而不是等 500ms 后的回传静默失败。
    const editable = Boolean(file)
      && (file.status === "completed" || file.status === "modified");
    const lock = editable ? "" : " disabled";
    const row = document.createElement("div");
    row.className = `subtitle-row${item.id === state.activeSubtitleId ? " active" : ""}`;
    row.dataset.id = String(item.id);
    row.innerHTML = `
      <span class="row-index">${position + 1}</span>
      <input class="time-input start-input" value="${escapeHtml(ocrSession.formatTimestamp(item.startMs))}" title="${t("起始时间")}" aria-label="${t("字幕起始时间")}"${lock} />
      <input class="time-input end-input" value="${escapeHtml(ocrSession.formatTimestamp(item.endMs))}" title="${t("结束时间")}" aria-label="${t("字幕结束时间")}"${lock} />
      <input class="text-input" value="${escapeHtml(item.text)}" aria-label="${t("OCR 识别文本")}"${lock} />
      <div class="row-actions">
        <button class="icon-btn merge-row" type="button" title="${t("与下一条合并")}"${isLast || !editable ? " disabled" : ""}>
          <svg class="svg-icon small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6l5 5 5-5"/><path d="M7 13l5 5 5-5"/></svg>
        </button>
        <button class="icon-btn edit-row" type="button" title="${t("定位到该字幕")}">
          <svg class="svg-icon small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button class="icon-btn delete-row" type="button" title="${t("删除该字幕")}"${lock}>
          <svg class="svg-icon small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
        </button>
      </div>
    `;

    const textInput = row.querySelector(".text-input");
    textInput.value = item.text;

    row.addEventListener("click", (event) => {
      // 点到行的任何位置都定位（时间框、文本框也算）；只有行内按钮交给按钮自己处理。
      // 注意不能重渲染列表，否则正在编辑的输入框会失去焦点。
      const target = event && event.target;
      const onButton = Boolean(target) && typeof target.closest === "function"
        && Boolean(target.closest(".row-actions"));
      if (onButton) return;
      activateCue(item.id, { seek: true, notify: false });
    });
    row.querySelector(".start-input").addEventListener("change", (event) => {
      applyCueTime(item.id, "start", event.target.value);
    });
    row.querySelector(".end-input").addEventListener("change", (event) => {
      applyCueTime(item.id, "end", event.target.value);
    });
    textInput.addEventListener("input", (event) => {
      pushCueHistory(file, {
        kind: "text", cueId: item.id, before: item.text, at: Date.now(),
        coalesceKey: `text:${item.id}`
      });
      item.text = event.target.value;
      updateSubtitleOverlay();
      updateTimelineBlockText(item.id, item.text);
      schedulePushCues();
    });
    row.querySelector(".merge-row").addEventListener("click", (event) => {
      event.stopPropagation();
      mergeSubtitleWithNext(item.id);
    });
    row.querySelector(".delete-row").addEventListener("click", (event) => {
      event.stopPropagation();
      deleteSubtitle(item.id);
    });
    row.querySelector(".edit-row").addEventListener("click", (event) => {
      event.stopPropagation();
      activateCue(item.id, { seek: true });
    });

    subtitleList.appendChild(row);
  });
}
// ------------------------------------------------------------ 字幕时间轴
// 只读时间轴：标尺 + 字幕泳道 + 播放头。缩放单位是 px/s，长视频按可视区虚拟化，
// 两小时片源也不会一次往 DOM 里塞几千个方块（SIDECAR_API.md 第 13 节）。
const TIMELINE_ZOOM_STEPS = [2, 5, 10, 20, 50, 100, 200, 400];
const TIMELINE_MIN_PPS = 0.5;
const TIMELINE_MAX_WIDTH_PX = 4000000;
const TIMELINE_OVERSCAN_PX = 480;
const TIMELINE_TICK_STEPS_MS = [
  100, 200, 500, 1000, 2000, 5000, 10000, 15000,
  30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000
];

function clearChildren(element) {
  if (!element) return;
  element.innerHTML = "";
  // 渲染层测试桩里的 children 是普通数组，改 innerHTML 清不掉它。
  if (Array.isArray(element.children)) element.children.length = 0;
}

function timelineCollapsed() {
  return state.timeline.collapsed === true || state.timeline.autoCollapsed === true;
}

function timelineDurationMs() {
  const fromPlayer = videoDurationMs();
  if (fromPlayer > 0) return fromPlayer;
  const file = getCurrentFile();
  const fromFile = Number(file && file.durationMs);
  return Number.isFinite(fromFile) && fromFile > 0 ? fromFile : 0;
}

function clampTimelinePps(value) {
  const durationMs = timelineDurationMs();
  const ceiling = durationMs > 0
    ? Math.max(1, TIMELINE_MAX_WIDTH_PX / (durationMs / 1000))
    : TIMELINE_ZOOM_STEPS[TIMELINE_ZOOM_STEPS.length - 1];
  const number = Number(value);
  const safe = Number.isFinite(number) && number > 0 ? number : 10;
  return Math.min(ceiling, Math.max(TIMELINE_MIN_PPS, safe));
}

function timelineTickStepMs(pps) {
  for (const step of TIMELINE_TICK_STEPS_MS) {
    if ((step / 1000) * pps >= 68) return step;
  }
  return TIMELINE_TICK_STEPS_MS[TIMELINE_TICK_STEPS_MS.length - 1];
}

function formatTimelineZoom(pps) {
  return `${pps >= 10 ? Math.round(pps) : pps.toFixed(1)} px/s`;
}

function timelineViewportWidth() {
  return Number(timelineScroll && timelineScroll.clientWidth) || 0;
}

function renderTimeline(cuesArg) {
  if (!timelineInner || !timelineRuler || !timelineBlocks) return;
  const file = getCurrentFile();
  const cues = cuesArg || (file ? sortCues(file.cues) : []);
  const durationMs = timelineDurationMs();
  const pps = clampTimelinePps(state.timeline.pps);
  state.timeline.pps = pps;
  if (timelineZoomLabel) timelineZoomLabel.textContent = formatTimelineZoom(pps);
  const collapsed = timelineCollapsed();
  if (timelinePanel) timelinePanel.classList.toggle("collapsed", collapsed);
  if (timelineCollapseButton) {
    timelineCollapseButton.textContent = collapsed ? t("展开") : t("收起");
    timelineCollapseButton.title = collapsed ? t("展开时间轴") : t("折叠时间轴");
  }
  // 折叠时不渲染方块：此时 clientWidth 为 0，虚拟化会退化成"全量渲染"。
  if (collapsed || durationMs <= 0) {
    clearChildren(timelineRuler);
    clearChildren(timelineBlocks);
    return;
  }
  const totalPx = Math.max(1, (durationMs / 1000) * pps);
  timelineInner.style.width = `${totalPx}px`;
  const viewport = timelineViewportWidth();
  let viewStartPx = 0;
  let viewEndPx = totalPx;
  if (viewport > 0) {
    const scrollLeft = Number(timelineScroll.scrollLeft) || 0;
    viewStartPx = Math.max(0, scrollLeft - TIMELINE_OVERSCAN_PX);
    viewEndPx = Math.min(totalPx, scrollLeft + viewport + TIMELINE_OVERSCAN_PX);
  }
  const ppsPerMs = pps / 1000;
  renderTimelineRuler(pps, durationMs, viewStartPx / ppsPerMs, viewEndPx / ppsPerMs);
  renderTimelineBlocks(cues, ppsPerMs, viewStartPx / ppsPerMs, viewEndPx / ppsPerMs);
  updateTimelinePlayhead();
}

function renderTimelineRuler(pps, durationMs, viewStartMs, viewEndMs) {
  clearChildren(timelineRuler);
  const stepMs = timelineTickStepMs(pps);
  const first = Math.max(0, Math.floor(viewStartMs / stepMs) * stepMs);
  const last = Math.min(durationMs, Math.max(viewEndMs, first));
  for (let ms = first; ms <= last + stepMs * 0.5; ms += stepMs) {
    const tick = document.createElement("div");
    tick.className = "timeline-tick";
    tick.style.left = `${(ms / 1000) * pps}px`;
    const label = document.createElement("span");
    label.className = "timeline-tick-label";
    label.textContent = secondsToClock(ms / 1000);
    tick.appendChild(label);
    timelineRuler.appendChild(tick);
  }
}

function renderTimelineBlocks(cues, ppsPerMs, viewStartMs, viewEndMs) {
  clearChildren(timelineBlocks);
  cues.forEach((cue) => {
    if (cue.endMs < viewStartMs || cue.startMs > viewEndMs) return;
    const block = document.createElement("div");
    const active = String(cue.id) === String(state.activeSubtitleId);
    block.className = `timeline-cue${active ? " active" : ""}`;
    block.dataset.id = String(cue.id);
    block.style.left = `${cue.startMs * ppsPerMs}px`;
    block.style.width = `${Math.max(2, (cue.endMs - cue.startMs) * ppsPerMs)}px`;
    block.title = `${ocrSession.formatTimestamp(cue.startMs)} → ${ocrSession.formatTimestamp(cue.endMs)}`;
    block.textContent = String(cue.text || "").trim();
    timelineBlocks.appendChild(block);
  });
}

function updateTimelinePlayhead(ms) {
  if (!timelinePlayhead) return;
  const durationMs = timelineDurationMs();
  const raw = Number.isFinite(Number(ms)) ? Number(ms) : (videoPlayer.currentTime || 0) * 1000;
  const clamped = Math.max(0, durationMs > 0 ? Math.min(raw, durationMs) : raw);
  const x = (clamped / 1000) * state.timeline.pps;
  timelinePlayhead.style.left = `${x}px`;
  // 播放时让播放头留在可视区；手动拖动进度条/滚动时不抢。
  if (!isVideoPlaying() || !timelineScroll) return;
  const viewport = timelineViewportWidth();
  if (viewport <= 0) return;
  const current = Number(timelineScroll.scrollLeft) || 0;
  if (x < current + 24) timelineScroll.scrollLeft = Math.max(0, x - viewport * 0.3);
  else if (x > current + viewport - 24) timelineScroll.scrollLeft = x - viewport * 0.7;
}

function updateTimelineHighlight() {
  if (!timelineBlocks || !timelineBlocks.children) return;
  for (const block of [...timelineBlocks.children]) {
    if (!block || !block.classList) continue;
    const id = block.dataset ? block.dataset.id : undefined;
    block.classList.toggle("active", id !== undefined && String(id) === String(state.activeSubtitleId));
  }
}

function timelineBlockElement(id) {
  if (!timelineBlocks || !timelineBlocks.children) return null;
  for (const block of [...timelineBlocks.children]) {
    if (block && block.dataset && String(block.dataset.id) === String(id)) return block;
  }
  return null;
}

// 改文本时不重渲染列表（会丢焦点），只把对应方块的文字换掉。
function updateTimelineBlockText(id, text) {
  const block = timelineBlockElement(id);
  if (block) block.textContent = String(text || "").trim();
}

function setTimelineBlockDragging(id, dragging) {
  const block = timelineBlockElement(id);
  if (block && block.classList) block.classList.toggle("dragging", dragging === true);
}

// 拖动时只挪这一个方块，不重渲染整条时间轴。
function updateTimelineBlockGeometry(cue) {
  const block = timelineBlockElement(cue.id);
  if (!block) return;
  const ppsPerMs = state.timeline.pps / 1000;
  block.style.left = `${cue.startMs * ppsPerMs}px`;
  block.style.width = `${Math.max(2, (cue.endMs - cue.startMs) * ppsPerMs)}px`;
}

// 拖动时同步对应行的两个时间框（不重建 DOM，输入框才不会失焦）。
function updateCueRowInputs(cue) {
  const row = cueRowElement(cue.id);
  if (!row || typeof row.querySelector !== "function") return;
  const active = document.activeElement;
  const startInput = row.querySelector(".start-input");
  const endInput = row.querySelector(".end-input");
  if (startInput && startInput !== active) startInput.value = ocrSession.formatTimestamp(cue.startMs);
  if (endInput && endInput !== active) endInput.value = ocrSession.formatTimestamp(cue.endMs);
}

function scrollTimelineToCue(id) {
  if (!timelineScroll || timelineCollapsed()) return;
  const file = getCurrentFile();
  const cue = file ? file.cues.find((item) => String(item.id) === String(id)) : null;
  const viewport = timelineViewportWidth();
  if (!cue || viewport <= 0) return;
  const pps = state.timeline.pps;
  const left = (cue.startMs / 1000) * pps;
  const right = (cue.endMs / 1000) * pps;
  const current = Number(timelineScroll.scrollLeft) || 0;
  const margin = 48;
  if (left < current + margin) timelineScroll.scrollLeft = Math.max(0, left - margin);
  else if (right > current + viewport - margin) timelineScroll.scrollLeft = right - viewport + margin;
}

function timelineInnerX(clientX) {
  const rect = timelineInner && typeof timelineInner.getBoundingClientRect === "function"
    ? timelineInner.getBoundingClientRect()
    : null;
  if (!rect) return null;
  return Number(clientX) - Number(rect.left);
}

function timelineMsFromClientX(clientX) {
  const x = timelineInnerX(clientX);
  const pps = state.timeline.pps;
  if (x === null || !(pps > 0)) return 0;
  const durationMs = timelineDurationMs();
  const ms = (x / pps) * 1000;
  return Math.max(0, durationMs > 0 ? Math.min(ms, durationMs) : ms);
}

// 以鼠标位置为锚点缩放：指针下的那一帧在缩放前后停在原地。
function setTimelineZoom(pps, anchorClientX) {
  if (!timelineScroll) return;
  const oldPps = Number(state.timeline.pps) || 0;
  const next = clampTimelinePps(pps);
  if (Math.abs(next - oldPps) < 1e-6) return;
  const scrollRect = typeof timelineScroll.getBoundingClientRect === "function"
    ? timelineScroll.getBoundingClientRect()
    : null;
  let anchorOffset = timelineViewportWidth() / 2;
  let anchorMs = oldPps > 0
    ? ((Number(timelineScroll.scrollLeft) || 0) + anchorOffset) / oldPps * 1000
    : 0;
  const x = typeof anchorClientX === "number" ? timelineInnerX(anchorClientX) : null;
  if (x !== null && scrollRect) {
    anchorOffset = Number(anchorClientX) - Number(scrollRect.left);
    anchorMs = oldPps > 0 ? (x / oldPps) * 1000 : 0;
  }
  state.timeline.pps = next;
  persistUi();
  renderTimeline();
  timelineScroll.scrollLeft = Math.max(0, (anchorMs / 1000) * next - anchorOffset);
}

function zoomTimelineStep(direction, anchorClientX) {
  const current = Number(state.timeline.pps) || 10;
  let next;
  if (direction > 0) {
    next = TIMELINE_ZOOM_STEPS.find((value) => value > current + 1e-6);
    if (!next) next = current * 1.6;
  } else {
    next = [...TIMELINE_ZOOM_STEPS].reverse().find((value) => value < current - 1e-6);
    if (!next) next = current / 1.6;
  }
  setTimelineZoom(next, anchorClientX);
}

function fitTimelineZoom() {
  const durationMs = timelineDurationMs();
  const viewport = timelineViewportWidth();
  if (!(durationMs > 0) || viewport <= 0) return;
  setTimelineZoom(viewport / (durationMs / 1000));
}

function toggleTimelineCollapsed() {
  state.timeline.collapsed = state.timeline.collapsed !== true;
  persistUi();
  renderTimeline();
}

// 窗口太矮时自动收起时间轴，把高度让给画面和字幕列表。
function syncTimelineViewport() {
  const height = typeof window !== "undefined" && Number.isFinite(Number(window.innerHeight))
    ? Number(window.innerHeight)
    : 0;
  state.timeline.autoCollapsed = height > 0 && height < 640;
  renderTimeline();
}

function seekTimelineTo(ms) {
  if (!videoPlayer.getAttribute("src")) return;
  if (isVideoPlaying()) videoPlayer.pause();
  hideStill();
  const target = commitSeek(ms);
  scheduleStillAt(target);
  updatePlayerControls();
}

function onTimelinePointerDown(event) {
  if (!event) return;
  if (typeof event.button === "number" && event.button > 0) return;
  const target = event.target;
  const block = target && typeof target.closest === "function"
    ? target.closest(".timeline-cue")
    : null;
  if (block && block.dataset && block.dataset.id !== undefined) {
    if (typeof event.preventDefault === "function") event.preventDefault();
    // 真的拖了 = 改时间，没拖 = 点击定位（在 pointerup 里区分）。
    if (beginTimelineDrag(block, event)) return;
  }
  if (typeof event.preventDefault === "function") event.preventDefault();
  seekTimelineTo(timelineMsFromClientX(event.clientX));
}

function bindTimeline() {
  if (timelineScroll) {
    timelineScroll.addEventListener("scroll", () => {
      // 拖动中不做虚拟化重排：方块被回收会让手里这一条直接消失。
      if (timelineDrag || timelineScrollRenderQueued) return;
      timelineScrollRenderQueued = true;
      requestAnimationFrame(() => {
        timelineScrollRenderQueued = false;
        renderTimeline();
      });
    }, { passive: true });
    timelineScroll.addEventListener("wheel", (event) => {
      if (!event) return;
      // Ctrl/⌘ + 滚轮 = 以指针为锚点缩放；普通滚轮当横向滚动用。
      if (event.ctrlKey || event.metaKey) {
        if (typeof event.preventDefault === "function") event.preventDefault();
        zoomTimelineStep(Number(event.deltaY) > 0 ? -1 : 1, event.clientX);
        return;
      }
      const deltaX = Number(event.deltaX) || 0;
      const deltaY = Number(event.deltaY) || 0;
      const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
      if (!delta) return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      timelineScroll.scrollLeft = (Number(timelineScroll.scrollLeft) || 0) + delta;
    }, { passive: false });
  }
  if (timelineLane) {
    timelineLane.addEventListener("pointerdown", onTimelinePointerDown);
    timelineLane.addEventListener("pointermove", (event) => {
      if (timelineDrag) moveTimelineDrag(event);
      else updateTimelineCursor(event);
    });
    timelineLane.addEventListener("pointerup", (event) => {
      if (timelineDrag) endTimelineDrag(event, {});
    });
    timelineLane.addEventListener("pointercancel", () => {
      if (timelineDrag) endTimelineDrag(null, { cancel: true });
    });
  }
  if (timelineRuler) {
    timelineRuler.addEventListener("pointerdown", onTimelinePointerDown);
    timelineRuler.addEventListener("dblclick", fitTimelineZoom);
  }
  if (timelineZoomInButton) timelineZoomInButton.addEventListener("click", () => zoomTimelineStep(1));
  if (timelineZoomOutButton) timelineZoomOutButton.addEventListener("click", () => zoomTimelineStep(-1));
  if (timelineFitButton) timelineFitButton.addEventListener("click", fitTimelineZoom);
  if (timelineCollapseButton) timelineCollapseButton.addEventListener("click", toggleTimelineCollapsed);
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", syncTimelineViewport);
  }
}

// ------------------------------------------------------------ 校对页宽度分隔条
// 拖分隔条改画面/列表两栏比例；存的是比例（0..1），跟随窗口宽度换算成左栏像素，
// 所以换窗口大小、最大化都还能保持这个比例。Esc 回滚、双击复位、方向键微调。
const PROOFREAD_SPLITTER_PX = 12;
const PROOFREAD_SPLIT_MIN_PX = 380;
const PROOFREAD_SPLIT_MIN_FRACTION = 0.3;
const PROOFREAD_SPLIT_STEP = 0.02;
const PROOFREAD_SPLIT_DEFAULT = 0.5;
const PROOFREAD_SPLIT_MIN_RATIO = 0.15;
const PROOFREAD_SPLIT_MAX_RATIO = 0.85;
let proofreadSplitDrag = null;

function setCssVar(element, name, value) {
  if (!element || !element.style) return;
  if (typeof element.style.setProperty === "function") {
    element.style.setProperty(name, value);
    return;
  }
  // smoke 的 DOM 桩里 style 是个普通对象，没有 setProperty。
  element.style[name] = value;
}

function proofreadGridWidth() {
  const rect = proofreadGrid && typeof proofreadGrid.getBoundingClientRect === "function"
    ? proofreadGrid.getBoundingClientRect()
    : null;
  return rect ? Number(rect.width) || 0 : 0;
}

// 两栏各至少占可用宽度的 30%，小窗口尽量保留 380px；空间不足时平分。
// 每次布局按当前宽度重算，显示器、窗口和侧边栏尺寸变化都沿用同一规则。
function proofreadSplitBounds() {
  const total = proofreadGridWidth();
  const available = Math.max(0, total - PROOFREAD_SPLITTER_PX);
  const minimum = Math.min(available / 2,
    Math.max(PROOFREAD_SPLIT_MIN_PX, available * PROOFREAD_SPLIT_MIN_FRACTION));
  return {
    total,
    minLeft: minimum,
    maxLeft: available - minimum
  };
}

function proofreadDraggable() {
  const bounds = proofreadSplitBounds();
  return bounds.total > 0 && bounds.maxLeft >= bounds.minLeft ? bounds : null;
}

function proofreadLeftPx(bounds) {
  const rect = proofreadVideoPanel && typeof proofreadVideoPanel.getBoundingClientRect === "function"
    ? proofreadVideoPanel.getBoundingClientRect()
    : null;
  const measured = rect ? Number(rect.width) || 0 : 0;
  return measured > 0 ? measured : state.proofreadSplit * bounds.total;
}

// 按已存的比例还原左栏宽度；量不到宽度（视图隐藏 / 首次布局前）就不写像素，
// 交给 CSS 里的比例兜底，等切回校对页再补一次。
function applyProofreadSplit() {
  const bounds = proofreadSplitBounds();
  const draggable = proofreadDraggable();
  const left = draggable
    ? clampNumber(state.proofreadSplit * bounds.total, draggable.minLeft, draggable.maxLeft,
      draggable.total * PROOFREAD_SPLIT_DEFAULT)
    : null;
  setCssVar(proofreadGrid, "--proofread-split", left === null ? "" : `${left}px`);
  if (proofreadSplitter && typeof proofreadSplitter.setAttribute === "function") {
    proofreadSplitter.setAttribute("aria-valuenow",
      String(Math.round(clampNumber(state.proofreadSplit, PROOFREAD_SPLIT_MIN_RATIO,
        PROOFREAD_SPLIT_MAX_RATIO, PROOFREAD_SPLIT_DEFAULT) * 100)));
  }
}

function setProofreadSplitLeft(left, bounds) {
  const value = clampNumber(left, bounds.minLeft, bounds.maxLeft, bounds.total * PROOFREAD_SPLIT_DEFAULT);
  state.proofreadSplit = clampNumber(value / bounds.total, PROOFREAD_SPLIT_MIN_RATIO,
    PROOFREAD_SPLIT_MAX_RATIO, PROOFREAD_SPLIT_DEFAULT);
  setCssVar(proofreadGrid, "--proofread-split", `${value}px`);
}

function onProofreadSplitterPointerDown(event) {
  if (proofreadSplitDrag) return;
  if (event && event.button !== undefined && event.button !== 0) return;
  const bounds = proofreadDraggable();
  if (!bounds) return;
  proofreadSplitDrag = {
    pointerId: event ? event.pointerId : undefined,
    startX: Number(event && event.clientX) || 0,
    startLeft: proofreadLeftPx(bounds),
    originRatio: state.proofreadSplit,
    bounds,
    moved: false
  };
  proofreadSplitter.classList.add("dragging");
  document.body.classList.add("proofread-splitting");
  if (typeof proofreadSplitter.setPointerCapture === "function"
    && proofreadSplitDrag.pointerId !== undefined) {
    try {
      proofreadSplitter.setPointerCapture(proofreadSplitDrag.pointerId);
    } catch (error) {
      /* 指针已经抬起：后面收不到 move 也不会出错 */
    }
  }
  if (event && typeof event.preventDefault === "function") event.preventDefault();
}

function moveProofreadSplitter(event) {
  if (!proofreadSplitDrag) return;
  const dx = (Number(event && event.clientX) || 0) - proofreadSplitDrag.startX;
  if (!proofreadSplitDrag.moved) {
    if (Math.abs(dx) < 2) return;
    proofreadSplitDrag.moved = true;
  }
  setProofreadSplitLeft(proofreadSplitDrag.startLeft + dx, proofreadSplitDrag.bounds);
  if (event && typeof event.preventDefault === "function") event.preventDefault();
}

function endProofreadSplitterDrag(event, options) {
  if (!proofreadSplitDrag) return;
  const drag = proofreadSplitDrag;
  proofreadSplitDrag = null;
  if (drag.pointerId !== undefined && typeof proofreadSplitter.releasePointerCapture === "function") {
    try {
      proofreadSplitter.releasePointerCapture(drag.pointerId);
    } catch (error) {
      /* 同上 */
    }
  }
  proofreadSplitter.classList.remove("dragging");
  document.body.classList.remove("proofread-splitting");
  if (options && options.cancel) {
    state.proofreadSplit = drag.originRatio;
    applyProofreadSplit();
    return;
  }
  if (drag.moved) persistUi();
}

function nudgeProofreadSplit(delta) {
  const bounds = proofreadDraggable();
  if (!bounds) return;
  setProofreadSplitLeft(proofreadLeftPx(bounds) + delta * bounds.total, bounds);
  persistUi();
}

function resetProofreadSplit() {
  state.proofreadSplit = PROOFREAD_SPLIT_DEFAULT;
  applyProofreadSplit();
  persistUi();
}

function bindProofreadSplitter() {
  if (proofreadSplitter) {
    proofreadSplitter.addEventListener("pointerdown", onProofreadSplitterPointerDown);
    proofreadSplitter.addEventListener("pointermove", moveProofreadSplitter);
    proofreadSplitter.addEventListener("pointerup", (event) => endProofreadSplitterDrag(event, {}));
    proofreadSplitter.addEventListener("pointercancel", () => endProofreadSplitterDrag(null, { cancel: true }));
    proofreadSplitter.addEventListener("dblclick", resetProofreadSplit);
    proofreadSplitter.addEventListener("keydown", (event) => {
      const key = event && event.key;
      if (key !== "ArrowLeft" && key !== "ArrowRight") return;
      // 全局方向键是逐帧微调播放头，焦点在分隔条上时拦下来只调宽度。
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      nudgeProofreadSplit(key === "ArrowLeft" ? -PROOFREAD_SPLIT_STEP : PROOFREAD_SPLIT_STEP);
    });
  }
  // 窗口缩放、侧边栏收起、界面缩放都会改这一行的宽度：ResizeObserver 一次盖住；
  // 环境没有它就退回监听 window.resize。拖动中不改，免得跟手里的像素打架。
  if (typeof ResizeObserver === "function" && proofreadGrid) {
    new ResizeObserver(() => {
      if (!proofreadSplitDrag) applyProofreadSplit();
    }).observe(proofreadGrid);
  } else if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("resize", applyProofreadSplit);
  }
}

// ------------------------------------------------------------ 时间轴拖动编辑（M6-P2）
// 三种拖法：拖主体整条平移、拖左端改 start、拖右端改 end。
// 约定：硬钳不推邻居；拖动中不 seek、不重渲染列表，松手才提交一次；Esc 回滚。
let timelineDrag = null;
const TIMELINE_DRAG_SLOP_PX = 3;
const TIMELINE_SNAP_PX = 6;
const TIMELINE_EDGE_PX = 7;
const TIMELINE_AUTOSCROLL_MARGIN_PX = 44;
const TIMELINE_AUTOSCROLL_STEP_PX = 28;

// 命中区：左右各一条窄边改起止，中间平移；方块很窄时三块按比例缩小。
function timelineZoneAt(block, clientX) {
  const rect = block && typeof block.getBoundingClientRect === "function"
    ? block.getBoundingClientRect()
    : null;
  if (!rect) return "move";
  const width = Number(rect.width) || 0;
  const localX = Number(clientX) - Number(rect.left);
  const edge = Math.min(TIMELINE_EDGE_PX, width / 3);
  if (localX <= edge) return "start";
  if (localX >= width - edge) return "end";
  return "move";
}

// 吸附：先看邻居边界 / 0 点，再看帧网格；按住 Alt 全关。
function snapDragMs(ms, pps, marks, frameMs, enabled) {
  const rounded = Math.round(ms);
  if (!enabled) return rounded;
  const tolerance = (TIMELINE_SNAP_PX / Math.max(0.001, pps)) * 1000;
  let best = null;
  let bestDistance = Infinity;
  marks.forEach((mark) => {
    if (!Number.isFinite(mark)) return;
    const distance = Math.abs(ms - mark);
    if (distance <= tolerance && distance < bestDistance) {
      bestDistance = distance;
      best = mark;
    }
  });
  if (best !== null) return Math.round(best);
  if (frameMs > 0) return Math.round(rounded / frameMs) * frameMs;
  return rounded;
}

function beginTimelineDrag(block, event) {
  const file = getCurrentFile();
  const id = block && block.dataset ? block.dataset.id : null;
  const cue = file && id !== null && id !== undefined
    ? file.cues.find((item) => String(item.id) === String(id))
    : null;
  if (!cue) return false;
  const editable = file.status === "completed" || file.status === "modified";
  const fps = Number(cue.fps) > 0 ? Number(cue.fps) : Number(file.fps);
  timelineDrag = {
    pointerId: event.pointerId,
    // 字幕锁着时只当点击处理，别让用户白拖一下以为改动生效了。
    mode: editable ? timelineZoneAt(block, event.clientX) : "click",
    cueId: cue.id,
    startClientX: Number(event.clientX) || 0,
    startScrollLeft: Number(timelineScroll && timelineScroll.scrollLeft) || 0,
    origin: { startMs: cue.startMs, endMs: cue.endMs },
    bounds: neighbourBounds(file.cues, cue),
    frameMs: Number.isFinite(fps) && fps > 0 ? 1000 / fps : 0,
    moved: false
  };
  if (timelineLane && timelineDrag.pointerId !== undefined
    && typeof timelineLane.setPointerCapture === "function") {
    try {
      timelineLane.setPointerCapture(timelineDrag.pointerId);
    } catch (error) {
      /* 没有指针捕获的环境（测试桩）忽略 */
    }
  }
  return true;
}

// 拖到容器边缘自动横向滚动，长视频才拖得动。
function autoScrollTimelineDuringDrag(clientX) {
  if (!timelineScroll || typeof timelineScroll.getBoundingClientRect !== "function") return;
  const viewport = timelineViewportWidth();
  if (viewport <= 0) return;
  const rect = timelineScroll.getBoundingClientRect();
  const localX = Number(clientX) - Number(rect.left);
  const current = Number(timelineScroll.scrollLeft) || 0;
  if (localX < TIMELINE_AUTOSCROLL_MARGIN_PX) {
    timelineScroll.scrollLeft = Math.max(0, current - TIMELINE_AUTOSCROLL_STEP_PX);
  } else if (localX > viewport - TIMELINE_AUTOSCROLL_MARGIN_PX) {
    timelineScroll.scrollLeft = current + TIMELINE_AUTOSCROLL_STEP_PX;
  }
}

function moveTimelineDrag(event) {
  if (!timelineDrag || !event) return;
  const file = getCurrentFile();
  const cue = file ? file.cues.find((item) => String(item.id) === String(timelineDrag.cueId)) : null;
  if (!cue) return;
  const clientX = Number(event.clientX) || 0;
  if (!timelineDrag.moved) {
    if (Math.abs(clientX - timelineDrag.startClientX) < TIMELINE_DRAG_SLOP_PX) return;
    timelineDrag.moved = true;
    // 高亮只在这一刻同步一次，之后每次 move 都遍历整张表太贵。
    setActiveSubtitle(cue.id);
    updateRowHighlight();
  }
  if (timelineDrag.mode === "click") return;
  setTimelineBlockDragging(timelineDrag.cueId, true);
  autoScrollTimelineDuringDrag(clientX);
  const pps = state.timeline.pps;
  const scrollLeft = Number(timelineScroll && timelineScroll.scrollLeft) || 0;
  // 用"内容坐标"算位移，自动滚动的那一段才算得进去。
  const deltaPx = (clientX + scrollLeft)
    - (timelineDrag.startClientX + timelineDrag.startScrollLeft);
  const deltaMs = (deltaPx / pps) * 1000;
  const snapping = event.altKey !== true;
  const origin = timelineDrag.origin;
  const bounds = timelineDrag.bounds;
  const frameMs = timelineDrag.frameMs;
  if (timelineDrag.mode === "start") {
    const ms = snapDragMs(origin.startMs + deltaMs, pps, [0, bounds.previousEnd], frameMs, snapping);
    setCueStartInBounds(cue, bounds, ms);
  } else if (timelineDrag.mode === "end") {
    const ms = snapDragMs(origin.endMs + deltaMs, pps, [bounds.nextStart], frameMs, snapping);
    setCueEndInBounds(cue, bounds, ms);
  } else {
    const duration = origin.endMs - origin.startMs;
    const marks = [0, bounds.previousEnd];
    if (bounds.nextStart !== null) marks.push(bounds.nextStart - duration);
    const ms = snapDragMs(origin.startMs + deltaMs, pps, marks, frameMs, snapping);
    moveCueInBounds(cue, bounds, ms);
  }
  updateTimelineBlockGeometry(cue);
  updateCueRowInputs(cue);
  if (typeof event.preventDefault === "function") event.preventDefault();
}

function endTimelineDrag(event, options) {
  if (!timelineDrag) return;
  const drag = timelineDrag;
  timelineDrag = null;
  if (timelineLane && drag.pointerId !== undefined
    && typeof timelineLane.releasePointerCapture === "function") {
    try {
      timelineLane.releasePointerCapture(drag.pointerId);
    } catch (error) {
      /* 同上 */
    }
  }
  setTimelineBlockDragging(drag.cueId, false);
  const file = getCurrentFile();
  const cue = file ? file.cues.find((item) => String(item.id) === String(drag.cueId)) : null;
  if (!cue) return;
  if (options && options.cancel) {
    cue.startMs = drag.origin.startMs;
    cue.endMs = drag.origin.endMs;
    updateTimelineBlockGeometry(cue);
    updateCueRowInputs(cue);
    return;
  }
  // 没真正拖动过、或字幕锁着：仍然只是"点击定位"。
  if (!drag.moved || drag.mode === "click") {
    activateCue(cue.id, { seek: true, scroll: true });
    return;
  }
  // 一次拖动（平移 / 拖左端 / 拖右端）算一步：before 取按下去时的位置。
  pushCueHistory(file, {
    kind: "time",
    cueId: cue.id,
    before: { startMs: drag.origin.startMs, endMs: drag.origin.endMs },
    at: Date.now()
  });
  sortCues(file.cues);
  updateSubtitleOverlay();
  schedulePushCues();
  renderSubtitles();
}

// hover 时给可拖动提示：方块本身不设 cursor，统一继承泳道的。
function updateTimelineCursor(event) {
  if (!timelineLane || !timelineLane.style) return;
  const target = event ? event.target : null;
  const block = target && typeof target.closest === "function"
    ? target.closest(".timeline-cue")
    : null;
  if (!block) {
    timelineLane.style.cursor = "";
    return;
  }
  timelineLane.style.cursor = timelineZoneAt(block, event.clientX) === "move" ? "grab" : "ew-resize";
}

// [ 和 ]：把当前字幕的起点 / 终点设到播放头位置。
function setActiveCueEdge(field) {
  const file = getCurrentFile();
  const cue = file ? file.cues.find((item) => String(item.id) === String(state.activeSubtitleId)) : null;
  if (!cue) {
    showToast(t("请先选中一条字幕"));
    return;
  }
  if (file.status !== "completed" && file.status !== "modified") {
    showToast(t("识别完成后才能编辑字幕"));
    return;
  }
  const ms = (videoPlayer.currentTime || 0) * 1000;
  const before = { startMs: cue.startMs, endMs: cue.endMs };
  if (field === "start") setCueStart(file.cues, cue, ms);
  else setCueEnd(file.cues, cue, ms);
  if (cue.startMs !== before.startMs || cue.endMs !== before.endMs) {
    pushCueHistory(file, { kind: "time", cueId: cue.id, before, at: Date.now() });
  }
  sortCues(file.cues);
  updateSubtitleOverlay();
  schedulePushCues();
  renderSubtitles();
}

function schedulePushCues() {
  const file = getCurrentFile();
  if (!file) return;
  // 记住改的是哪一个视频：500ms 内切到别的视频时，这次编辑不能跟着"当前视频"跑偏。
  state.pushTargetId = file.id;
  markCuesDirty(file);
  scheduleFileRender();
  // 关掉"自动保存"时只留在内存里，等切视频 / 导出 / 关窗口这些时机再一起写盘。
  if (state.settings.autoSave === false) return;
  clearTimeout(state.pushTimer);
  state.pushTimer = setTimeout(() => pushCues(state.pushTargetId), 500);
}

// 每次本地编辑都推一个版本号：回传是异步的，回传成功时如果版本已经变了，说明用户
// 又改过了，这时不能把"待保存"清掉（否则那次改动会悄悄丢掉）。
function markCuesDirty(file) {
  file.cueRevision = (file.cueRevision || 0) + 1;
  file.dirty = true;
}

// 导出 / 切视频 / 退出前的兜底：把还没落盘的编辑全部推给后端——防抖窗口里的、
// 关掉自动保存攒下来的、后端断线时没推成功的都在里面，否则写出来的是改动前的内容。
async function flushPendingCues() {
  if (state.pushTimer) {
    clearTimeout(state.pushTimer);
    state.pushTimer = null;
  }
  for (const file of state.files.slice()) {
    if (!file.dirty) continue;
    await pushCues(file.id);
  }
}

// 字幕重新落盘成功（OCR 跑完 / 手动导出）后清掉"写盘失败"的警告，让界面与磁盘重新一致。
function clearWriteError(id) {
  const file = findFile(id);
  if (file) file.writeError = null;
}

async function pushCues(targetId) {
  if (state.pushTimer) {
    clearTimeout(state.pushTimer);
    state.pushTimer = null;
  }
  const file = (targetId ? findFile(targetId) : null) || getCurrentFile();
  if (!file) return;
  if (!state.backend.ready) {
    // 后端断线/重连中：改动只能留在界面上，连上以后再补传（bootstrapBackend
    // 会再调一次 flushPendingCues）。不能静默丢掉——那样行里显示"已完成"、
    // 磁盘还是旧的，用户会以为已经存住了。
    file.dirty = true;
    file.writeError = {
      code: "E_BACKEND_NOT_READY",
      get message() { return t("OCR 后端未连接，字幕改动还没写盘"); },
      get detail() { return t("恢复连接后会自动补传"); }
    };
    if (!file.backendDownNotified) {
      file.backendDownNotified = true;
      showToast(t("OCR 后端未连接，字幕改动还没保存；恢复连接后会自动补传"));
    }
    scheduleFileRender();
    return;
  }
  if (file.status !== "completed" && file.status !== "modified") {
    showToast(t("字幕已重新排队，这次编辑没有保存"));
    return;
  }
  const revision = file.cueRevision || 0;
  try {
    const result = await window.ocrSession.updateCues(
      file.id, file.cues.map(ocrSession.cueToBackend));
    file.status = result.state || "modified";
    if (result.outputPath) file.outputPath = result.outputPath;
    // 后端写盘失败时改动只在内存里：不能只显示"已修改"，否则用户以为已经存住。
    file.writeError = result.writeError || null;
    // 后端收下了（并写盘成功）才算不用再保存；写盘失败时继续挂着"待保存"。
    // 回传期间又改过（版本变了）就什么都不动：新的那次编辑还会再回传一遍。
    if ((file.cueRevision || 0) === revision) {
      file.dirty = Boolean(result.writeError);
    }
    file.backendDownNotified = false;
    if (file.writeError) {
      showToast(t("字幕已改，但 SRT 写盘失败：{0}", [file.writeError.message]), {
        get label() { return t("查看详情"); },
        onClick: () => showError({
          ...file.writeError,
          message: t("SRT 写盘失败：{0}", [file.writeError.message]),
          videoPath: file.path,
          outputPath: file.outputPath,
          source: "srt.writeFailed"
        })
      });
    }
    renderFiles();
  } catch (error) {
    // 后端说这条视频正在重新识别（E_TASK_BUSY）：这份改动基于上一遍的字幕，
    // 识别结果一到就会被整体替换（applyCues 会清掉 dirty）。这时不能标成
    // "待保存"，否则退出前 flushPendingCues 会把这份过期内容再推一遍。
    if (error.code === "E_TASK_BUSY") {
      file.dirty = false;
      scheduleFileRender();
      showToast(t("该视频正在识别，这次字幕改动没有保存"));
      return;
    }
    file.dirty = true;
    scheduleFileRender();
    // 回传失败是显式错误：错误码和详细报错都要落盘，点「查看详情」能看全文。
    const report = {
      code: error.code || "E_INTERNAL",
      message: t("字幕回传失败：{0}", [error.message]),
      detail: error.detail,
      videoPath: file.path,
      source: "task.updateCues"
    };
    reportError(report);
    showToast(t("字幕回传失败：{0}", [error.message]), {
      get label() { return t("查看详情"); },
      onClick: () => showError(report, { skipLog: true })
    });
  }
}

function setActiveSubtitle(id) {
  state.activeSubtitleId = id;
  const file = getCurrentFile();
  if (file) file.activeCueId = id;
  updateSubtitleOverlay();
}

// 校对工具：增删改合并都走这里，保证列表、覆盖层和磁盘上的 SRT 一致。
const MIN_CUE_MS = 50;
const DEFAULT_CUE_MS = 2000;

// 时间轴顺序就是 SRT 顺序（后端按传入顺序写文件），列表和回传都用这个顺序。
function sortCues(cues) {
  cues.sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs));
  return cues;
}

function cueAtTime(cues, positionMs) {
  for (const cue of cues) {
    if (cue.startMs <= positionMs && positionMs < cue.endMs) return cue;
  }
  return null;
}

function neighbourBounds(cues, cue) {
  const ordered = sortCues(cues.slice());
  const position = ordered.findIndex((item) => item.id === cue.id);
  return {
    previousEnd: position > 0 ? ordered[position - 1].endMs : 0,
    nextStart: position >= 0 && position < ordered.length - 1
      ? ordered[position + 1].startMs
      : null
  };
}

// 下面三个是列表输入框和时间轴拖动共用的编辑原语：都不许倒序、零长度、压到邻居身上。
// bounds 由 neighbourBounds() 预先算好——拖动时每个 pointermove 都重算一次太浪费。
function cueDuration(cue) {
  return Math.max(MIN_CUE_MS, cue.endMs - cue.startMs);
}

// 整条平移：时长不变，起点硬钳在 [前一条结束, 后一条开始 - 时长]，不推邻居。
function moveCueInBounds(cue, bounds, startMs) {
  const duration = cueDuration(cue);
  const ceiling = bounds.nextStart === null ? Infinity : bounds.nextStart - duration;
  let start = Math.max(0, Math.round(startMs), bounds.previousEnd);
  if (Number.isFinite(ceiling) && ceiling >= bounds.previousEnd) start = Math.min(start, ceiling);
  cue.startMs = start;
  cue.endMs = start + duration;
  // 空隙装不下整条时宁可压短，也不要压到邻居身上。
  if (bounds.nextStart !== null && cue.endMs > bounds.nextStart) {
    cue.endMs = Math.max(cue.startMs + MIN_CUE_MS, bounds.nextStart);
  }
}

// 拖左端：只动 start，end 不动。
function setCueStartInBounds(cue, bounds, startMs) {
  const lower = bounds.previousEnd;
  const upper = Math.max(lower, cue.endMs - MIN_CUE_MS);
  cue.startMs = Math.min(Math.max(0, Math.round(startMs), lower), upper);
  if (cue.endMs < cue.startMs + MIN_CUE_MS) cue.endMs = cue.startMs + MIN_CUE_MS;
}

// 拖右端：只动 end，start 不动。
function setCueEndInBounds(cue, bounds, endMs) {
  const lower = cue.startMs + MIN_CUE_MS;
  const ceiling = bounds.nextStart === null ? Infinity : bounds.nextStart;
  let end = Math.max(Math.round(endMs), lower);
  if (Number.isFinite(ceiling) && end > ceiling && ceiling >= lower) end = ceiling;
  cue.endMs = end;
}

function setCueStart(cues, cue, startMs) {
  setCueStartInBounds(cue, neighbourBounds(cues, cue), startMs);
}

function setCueEnd(cues, cue, endMs) {
  setCueEndInBounds(cue, neighbourBounds(cues, cue), endMs);
}

// ------------------------------------------------------------ 校对撤回
// 每个视频记最近 20 步可撤回的校对改动。记录里只放 id 和改前的值，不持有 cue
// 对象、也不做整份快照，所以一步就是几百字节：2000 条字幕的片子跑满 20 步只有
// 几十 KB，几十个视频一起开着也几乎不占内存。
const CUE_HISTORY_LIMIT = 20;
// 同一个输入框里连续敲字算一步：这段时间内的击键合并进上一条记录。
const CUE_HISTORY_COALESCE_MS = 1000;

function resetCueHistory(file) {
  if (file) file.history = { entries: [] };
}

function pushCueHistory(file, entry) {
  if (!file) return;
  const history = file.history || (file.history = { entries: [] });
  const top = history.entries[history.entries.length - 1];
  if (entry.coalesceKey && top && top.coalesceKey === entry.coalesceKey
    && entry.at - top.at <= CUE_HISTORY_COALESCE_MS) {
    // 继续合并：before 保持这一串连续编辑开始前的值。
    top.at = entry.at;
    return;
  }
  history.entries.push(entry);
  if (history.entries.length > CUE_HISTORY_LIMIT) history.entries.shift();
}

function cueById(file, id) {
  return file.cues.find((cue) => String(cue.id) === String(id)) || null;
}

// 回滚一条历史记录。返回 false 表示这条已经回滚不了（目标被后续操作改掉了），
// 调用方跳过去继续往前找。
function applyCueHistoryEntry(file, entry) {
  if (entry.kind === "delete") {
    if (cueById(file, entry.cue.id)) return false;
    file.cues.push({ ...entry.cue });
    sortCues(file.cues);
    setActiveSubtitle(entry.cue.id);
  } else if (entry.kind === "add") {
    const cue = cueById(file, entry.cueId);
    if (!cue) return false;
    file.cues = file.cues.filter((item) => item.id !== cue.id);
    if (String(state.activeSubtitleId) === String(cue.id)) {
      const last = file.cues[file.cues.length - 1];
      setActiveSubtitle(last ? last.id : null);
    }
  } else if (entry.kind === "merge") {
    const cue = cueById(file, entry.cueId);
    if (!cue) return false;
    cue.endMs = entry.before.endMs;
    if (!cueById(file, entry.removed.id)) file.cues.push({ ...entry.removed });
    sortCues(file.cues);
    setActiveSubtitle(cue.id);
  } else {
    const cue = cueById(file, entry.cueId);
    if (!cue) return false;
    if (entry.kind === "text") {
      cue.text = entry.before;
      // 不重建列表（会把正在编辑的输入框冲掉），只把这一行的值填回去。
      const row = cueRowElement(cue.id);
      const input = row && typeof row.querySelector === "function"
        ? row.querySelector(".text-input") : null;
      if (input) input.value = entry.before;
      updateTimelineBlockText(cue.id, entry.before);
      updateSubtitleOverlay();
      return true;
    }
    cue.startMs = entry.before.startMs;
    cue.endMs = entry.before.endMs;
    sortCues(file.cues);
  }
  updateSubtitleOverlay();
  renderSubtitles();
  return true;
}

// 撤回提示里的短标签：太长会把 toast 撑开（和删除提示一个路子）。
function cueHistoryLabel(entry) {
  if (entry.kind === "text") return t("文字改动");
  if (entry.kind === "time") return t("时间改动");
  if (entry.kind === "add") return t("新增字幕");
  if (entry.kind === "delete") return t("恢复「{0}」", [cuePreview(entry.cue.text)]);
  return t("合并「{0}」", [cuePreview(entry.removed.text)]);
}

// Ctrl+Z：撤回这个视频最近一步校对改动，并像手动改一样回传后端写盘。
function undoCueEdit() {
  const file = getCurrentFile();
  const history = file && file.history;
  if (!file || !history || history.entries.length === 0) {
    showToast(t("没有可撤回的改动"));
    return;
  }
  if (file.status !== "completed" && file.status !== "modified") {
    showToast(t("识别完成后才能撤回修改"));
    return;
  }
  while (history.entries.length) {
    const entry = history.entries.pop();
    if (!applyCueHistoryEntry(file, entry)) continue;
    schedulePushCues();
    showToast(t("已撤回：{0}", [cueHistoryLabel(entry)]));
    return;
  }
  showToast(t("没有可撤回的改动"));
}

function applyCueTime(id, field, raw) {
  const file = getCurrentFile();
  const cue = file ? file.cues.find((item) => item.id === id) : null;
  if (!cue) return;
  const parsed = ocrSession.parseTimestamp(raw);
  if (parsed === null) {
    showToast(t("时间格式应为 00:00:00,000（小时最多 3 位）"));
    renderSubtitles();
    return;
  }
  const before = { startMs: cue.startMs, endMs: cue.endMs };
  // 两个框各自只动自己那一端（整条平移在时间轴上拖主体）；越界/压到邻居就地夹紧。
  if (field === "start") setCueStartInBounds(cue, neighbourBounds(file.cues, cue), parsed);
  else setCueEndInBounds(cue, neighbourBounds(file.cues, cue), parsed);
  const wanted = Math.round(parsed);
  const actual = field === "start" ? cue.startMs : cue.endMs;
  // 值没变（比如在输入框里回车但没改内容）就不占一步撤回。
  if (cue.startMs !== before.startMs || cue.endMs !== before.endMs) {
    pushCueHistory(file, { kind: "time", cueId: cue.id, before, at: Date.now() });
  }
  sortCues(file.cues);
  updateSubtitleOverlay();
  schedulePushCues();
  renderSubtitles();
  // 被硬边界改过就说一句为什么：不提示等于静默改值。
  if (wanted !== actual) showToast(cueTimeClampHint(field, wanted, actual));
}

function cueTimeClampHint(field, wanted, actual) {
  const value = ocrSession.formatTimestamp(actual);
  if (field === "start") {
    return wanted > actual
      ? t("起始时间已调整到 {0}：不能晚于结束时间", [value])
      : t("起始时间已调整到 {0}：不能早于上一条字幕的结束时间", [value]);
  }
  return wanted > actual
    ? t("结束时间已调整到 {0}：不能与下一条字幕重叠", [value])
    : t("结束时间已调整到 {0}：不能早于起始时间", [value]);
}

function newCueId(cues) {
  return cues.reduce((max, cue) => Math.max(max, Number(cue.id) || 0), 0) + 1;
}

// 选中一条字幕：高亮并滚动到可见位置，按需定位到它的开始时间。
// 这里不重渲染列表，否则正在编辑的输入框会失去焦点。
function activateCue(id, options = {}) {
  const file = getCurrentFile();
  const cue = file ? file.cues.find((item) => String(item.id) === String(id)) : null;
  if (!cue) return;
  setActiveSubtitle(cue.id);
  if (options.seek) seekToCue(cue, { notify: options.notify !== false });
  updateRowHighlight();
  if (options.scroll !== false) {
    scrollCueRowIntoView(cue.id);
    scrollTimelineToCue(cue.id);
  }
}

function updateRowHighlight() {
  updateTimelineHighlight();
  for (const row of [...subtitleList.children]) {
    if (!row.classList) continue;
    const id = row.dataset ? row.dataset.id : undefined;
    row.classList.toggle(
      "active", id !== undefined && String(id) === String(state.activeSubtitleId));
  }
}

function cueRowElement(id) {
  if (typeof subtitleList.querySelector !== "function") return null;
  return subtitleList.querySelector(`.subtitle-row[data-id="${id}"]`);
}

function scrollCueRowIntoView(id) {
  const row = cueRowElement(id);
  if (row && typeof row.scrollIntoView === "function") {
    row.scrollIntoView({ block: "nearest" });
  }
}

function focusCueRow(id, selectAll) {
  const row = cueRowElement(id);
  const input = row && typeof row.querySelector === "function"
    ? row.querySelector(".text-input")
    : null;
  if (!input || typeof input.focus !== "function") return;
  input.focus();
  if (selectAll && typeof input.select === "function") input.select();
}

// 给新字幕挑位置：从希望的位置往后找最近的、能放下至少 MIN_CUE_MS 的空档。
// 空档比默认时长窄就按空档长度收（不跨到邻居身上）；moved = 原来那个位置被占了。
function nextFreeCueSlot(cues, desiredMs) {
  const ordered = sortCues(cues.slice());
  const desired = Math.max(0, Math.round(desiredMs));
  let start = desired;
  for (let step = 0; step < ordered.length; step += 1) {
    const blocker = ordered.find((cue) => (cue.startMs <= start && start < cue.endMs)
      || (cue.startMs > start && cue.startMs - start < MIN_CUE_MS));
    if (!blocker) break;
    start = Math.max(start, Math.round(blocker.endMs));
  }
  const next = ordered.find((cue) => cue.startMs > start) || null;
  const room = next ? next.startMs - start : Infinity;
  return { startMs: start, endMs: start + Math.min(DEFAULT_CUE_MS, room), moved: start !== desired };
}

function addSubtitle() {
  const file = getCurrentFile();
  if (!file) {
    showToast(t("请先选择视频，再新增字幕"));
    return;
  }
  if (file.status !== "completed" && file.status !== "modified") {
    showToast(t("识别完成后才能编辑字幕"));
    return;
  }
  const cues = sortCues(file.cues);
  const active = cues.find((item) => item.id === state.activeSubtitleId) || null;
  const playheadMs = videoPlayer.src ? Math.round((videoPlayer.currentTime || 0) * 1000) : null;
  // 默认接在当前字幕之后；播放位置已经越过它时，按播放位置插入更贴近眼前这一帧。
  let wanted = active ? active.endMs + 100 : (playheadMs === null ? 0 : playheadMs);
  if (active && playheadMs !== null && playheadMs > wanted) wanted = playheadMs;
  // 新字幕不许跟已有字幕重叠：位置被占了就往后的空档挪。
  const slot = nextFreeCueSlot(cues, wanted);
  const cue = {
    id: newCueId(cues),
    startMs: slot.startMs,
    endMs: slot.endMs,
    get text() { return t("新字幕"); },
    confidence: 1,
    fps: file.fps || 0,
    startFrame: null,
    endFrame: null
  };
  file.cues.push(cue);
  sortCues(file.cues);
  pushCueHistory(file, { kind: "add", cueId: cue.id, at: Date.now() });
  setActiveSubtitle(cue.id);
  updateSubtitleOverlay();
  schedulePushCues();
  renderSubtitles();
  focusCueRow(cue.id, true);
  if (slot.moved) showToast(t("已添加到最近的下一个空余区域"));
}

// 撤销提示里的短标题：太长会把 toast 撑开。
function cuePreview(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim() || t("空字幕");
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

// 误点删除很常见：把删掉的那条按原位置放回去（顺序由 sortCues 决定）。
function restoreSubtitle(fileId, cue) {
  const file = findFile(fileId);
  if (!file || file.cues.some((item) => item.id === cue.id)) return;
  // 这次还原就是那条删除记录的撤回：把记录一起弹掉，免得再占一步。
  const top = file.history && file.history.entries[file.history.entries.length - 1];
  if (top && top.kind === "delete" && String(top.cue.id) === String(cue.id)) {
    file.history.entries.pop();
  }
  file.cues = sortCues([...file.cues, cue]);
  setActiveSubtitle(cue.id);
  updateSubtitleOverlay();
  schedulePushCues();
  renderSubtitles();
  focusCueRow(cue.id, true);
}

function deleteSubtitle(id) {
  const file = getCurrentFile();
  if (!file) return;
  const cues = sortCues(file.cues);
  const position = cues.findIndex((item) => item.id === id);
  if (position < 0) return;
  const removedCue = cues[position];
  file.cues = cues.filter((item) => item.id !== id);
  pushCueHistory(file, { kind: "delete", cue: { ...removedCue }, at: Date.now() });
  if (!file.cues.some((item) => item.id === state.activeSubtitleId)) {
    const fallback = file.cues[Math.min(position, file.cues.length - 1)] || null;
    setActiveSubtitle(fallback ? fallback.id : null);
  }
  updateSubtitleOverlay();
  schedulePushCues();
  renderSubtitles();
  showToast(t("已删除「{0}」", [cuePreview(removedCue.text)]), {
    get label() { return t("撤销"); },
    onClick: () => restoreSubtitle(file.id, removedCue)
  });
}

// 合并到下一条：时间轴接起来（当前条开始 → 下一条结束），文字只保留当前条。
function mergeSubtitleWithNext(id) {
  const file = getCurrentFile();
  if (!file) return;
  const cues = sortCues(file.cues);
  const position = cues.findIndex((item) => item.id === id);
  if (position < 0 || position >= cues.length - 1) {
    showToast(t("已经是最后一条字幕，没有可合并的下一条"));
    return;
  }
  const current = cues[position];
  const next = cues[position + 1];
  const beforeEnd = current.endMs;
  current.endMs = Math.max(next.endMs, current.startMs + MIN_CUE_MS);
  file.cues = cues.filter((item) => item.id !== next.id);
  pushCueHistory(file, {
    kind: "merge",
    cueId: current.id,
    before: { endMs: beforeEnd },
    removed: { ...next },
    at: Date.now()
  });
  setActiveSubtitle(current.id);
  updateSubtitleOverlay();
  schedulePushCues();
  renderSubtitles();
}

function updateSubtitleOverlay() {
  const cues = getCurrentSubtitles();
  const active = cues.find((item) => item.id === state.activeSubtitleId) || null;
  const playing = state.settings.followPlayback === false || !videoPlayer.src
    ? null
    : cueAtTime(cues, (videoPlayer.currentTime || 0) * 1000);
  const cue = playing || active;
  $("#subtitleOverlay").textContent = cue && cue.text
    ? cue.text
    : t("选择视频后在这里播放并校对字幕");
}

// 定格帧：暂停态 seek 不保证重绘，所以"这一帧长什么样"直接问后端解码器，
// 显示在画面外面，既不遮挡原生进度条，mkv/avi 也能用（SIDECAR_API.md 第12节）。
let stillToken = 0;
let stillKey = "";
let stillTimer = null;

function hideStill() {
  clearTimeout(stillTimer);
  stillTimer = null;
  stillToken += 1;
  stillKey = "";
  if (stillOverlay) {
    stillOverlay.classList.add("hidden");
    stillOverlay.classList.remove("empty");
  }
  if (stillImage) stillImage.removeAttribute("src");
  if (stillTime) stillTime.textContent = "--:--:--";
}

// 取不到帧时不要把定格层整个收掉：用户分不清“还没点”和“取不回来”。
// .empty 不铺背景、只留右上角说明，画面和按钮照常能点。
function showStillMessage(message) {
  if (!stillOverlay) return;
  stillOverlay.classList.remove("hidden");
  stillOverlay.classList.add("empty");
  if (stillImage) stillImage.removeAttribute("src");
  if (stillTime) stillTime.textContent = message || t("定格帧不可用");
}

function frameTimeLabel(cueMs, frameMs) {
  const cue = secondsToClock(Math.max(0, cueMs) / 1000);
  if (!Number.isFinite(frameMs)) return t("{0} · 定格帧", [cue]);
  const frame = secondsToClock(Math.max(0, frameMs) / 1000);
  // 正常情况下两者只差一帧；差得多说明字幕时钟和片源帧时钟对不上（时间轴偏移 /
  // 变帧率），这时候要明说，别让用户以为是自己点错了。
  const driftMs = Math.abs(frameMs - cueMs);
  const note = driftMs > 250 ? t("（时间轴偏差 {0}s）", [(driftMs / 1000).toFixed(1)]) : "";
  return frame === cue ? t("定格帧 · {0}{1}", [frame, note]) : t("字幕 {0} · 定格帧 {1}{2}", [cue, frame, note]);
}

// 定格帧不依赖播放器状态：mkv/avi 预览不可用时也能看。
function requestCueFrame(file, cue, timeMs) {
  return requestStill(file, timeMs, cue ? cue.startMs : null);
}

function stillEnabled() {
  return state.settings.nativeControls !== true;
}

// 键盘步进 / 拖动进度条之后补一张定格帧，否则画面还是停在旧帧上。
function scheduleStillAt(ms) {
  const file = getCurrentFile();
  if (!file || !stillEnabled()) return;
  clearTimeout(stillTimer);
  stillTimer = setTimeout(() => {
    stillTimer = null;
    requestStill(file, ms, null);
  }, 160);
}

async function requestStill(file, timeMs, cueMs) {
  if (!stillOverlay || !stillImage || !file) return;
  if (!stillEnabled()) {
    hideStill();
    return;
  }
  const key = `${file.id}:${Math.round(timeMs)}`;
  if (stillKey === key) return;
  const preview = state.backend.capabilities && state.backend.capabilities.preview;
  if (!state.backend.ready) return;
  if (!window.ocrSession || !window.ocrSession.videoFrame
    || (preview && preview.frameAvailable === false)) {
    showStillMessage(t("当前安装包不支持取帧"));
    return;
  }
  stillKey = key;
  const token = ++stillToken;
  // 取帧期间先收起上一张图，避免旧帧和新时间码配在一起看着像“取错了”。
  stillOverlay.classList.remove("hidden");
  stillOverlay.classList.add("empty");
  if (stillTime) stillTime.textContent = t("正在取帧…");
  try {
    const source = file.previewLocalPath || file.path;
    let result;
    try {
      result = await window.ocrSession.videoFrame(source, Math.round(timeMs));
    } catch (error) {
      // 预览缓存可能已经被淘汰：退回原片取帧（时间轴一致）。
      if (!file.previewLocalPath || file.previewLocalPath === file.path) throw error;
      result = await window.ocrSession.videoFrame(file.path, Math.round(timeMs));
    }
    if (token !== stillToken) return;
    if (!result || !result.path) throw new Error(t("后端没有返回帧文件"));
    const url = await fileUrl(result.path);
    if (token !== stillToken) return;
    stillOverlay.classList.remove("empty");
    stillImage.src = url;
    const labelMs = cueMs === null || cueMs === undefined ? Math.round(timeMs) : cueMs;
    if (stillTime) stillTime.textContent = frameTimeLabel(labelMs, result.timeMs);
  } catch (error) {
    if (token !== stillToken) return;
    stillKey = "";
    showStillMessage(t("定格帧取不回，该视频可能无法解码"));
  }
}

// 自绘播放控件条（B 步）：关掉原生控件之后，定格帧才能盖在画面上而不压住进度条。
// 拖动进度条只在 pointerup 提交一次 seek——每次 mousemove 都 seek 会让解码器反复 flush
// 并重新初始化（沿用早期 Qt 版 _seek_moved/_seek_released 的做法）。
let scrubState = null;
const SPEED_STEPS = [0.5, 1, 1.5, 2];

function videoDurationMs() {
  const seconds = Number(videoPlayer.duration);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function isVideoPlaying() {
  return videoPlayer.paused === false;
}

function bufferedPercent(totalMs) {
  if (!(totalMs > 0)) return "0%";
  try {
    const ranges = videoPlayer.buffered;
    if (!ranges || !ranges.length) return "0%";
    const ratio = ranges.end(ranges.length - 1) * 1000 / totalMs;
    return `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(3)}%`;
  } catch (error) {
    return "0%";
  }
}

function syncTransport(ms) {
  const total = videoDurationMs();
  const clamped = Math.max(0, total > 0 ? Math.min(ms, total) : ms);
  const percent = total > 0 ? `${(clamped / total * 100).toFixed(3)}%` : "0%";
  if (seekPlayed) seekPlayed.style.width = percent;
  if (seekThumb) seekThumb.style.left = percent;
  if (seekBuffered) seekBuffered.style.width = bufferedPercent(total);
  if (pcCurrentTime) pcCurrentTime.textContent = secondsToClock(clamped / 1000);
  updateTimelinePlayhead(clamped);
}

// 控件条、图标、音量都跟着播放器状态走：任何状态变化后调一次就够。
function updatePlayerControls() {
  const hasSource = Boolean(videoPlayer.getAttribute("src"));
  const native = state.settings.nativeControls === true;
  videoPlayer.controls = native;
  if (playerControls) playerControls.classList.toggle("hidden", !hasSource || native);
  if (!hasSource || native) setVolumePopoverOpen(false);
  if (seekTrack) seekTrack.classList.toggle("disabled", !hasSource);
  [playPauseButton, volumeButton, muteButton, speedButton, volumeRange, $("#fullscreenButton")]
    .forEach((element) => {
      if (element) element.disabled = !hasSource;
    });
  const playing = isVideoPlaying();
  const iconPlay = playPauseButton && playPauseButton.querySelector(".pc-icon-play");
  const iconPause = playPauseButton && playPauseButton.querySelector(".pc-icon-pause");
  if (iconPlay) iconPlay.classList.toggle("hidden", playing);
  if (iconPause) iconPause.classList.toggle("hidden", !playing);
  const muted = videoPlayer.muted === true || videoPlayer.volume === 0;
  const iconVolume = volumeButton && volumeButton.querySelector(".pc-icon-volume");
  const iconMuted = volumeButton && volumeButton.querySelector(".pc-icon-muted");
  if (iconVolume) iconVolume.classList.toggle("hidden", muted);
  if (iconMuted) iconMuted.classList.toggle("hidden", !muted);
  if (muteButton) muteButton.setAttribute("aria-pressed", String(muted));
  if (pcDuration) pcDuration.textContent = secondsToClock(videoDurationMs() / 1000);
  if (speedButton) speedButton.textContent = `${(Number(videoPlayer.playbackRate) || 1).toFixed(1)}×`;
  if (volumeRange) {
    const level = muted ? 0 : Number(videoPlayer.volume);
    volumeRange.value = String(Math.round(Math.max(0, Math.min(1, level)) * 100));
    if (volumeValue) volumeValue.textContent = volumeRange.value;
  }
  syncTransport((videoPlayer.currentTime || 0) * 1000);
}

// 所有定位都走这里：画面位置、控件条、跟随高亮一次同步。
function commitSeek(ms) {
  const total = videoDurationMs();
  let target = Math.max(0, Math.round(ms));
  if (total > 0) target = Math.min(target, total);
  videoPlayer.currentTime = target / 1000;
  syncTransport(target);
  updateVideoTime();
  return target;
}

function togglePlayback() {
  if (!videoPlayer.getAttribute("src")) return;
  if (isVideoPlaying()) {
    videoPlayer.pause();
    updatePlayerControls();
    return;
  }
  const total = videoDurationMs();
  // 停在结尾时再点播放：从头开始，别让用户以为按钮坏了。
  if (total > 0 && (videoPlayer.currentTime || 0) * 1000 >= total - 40) commitSeek(0);
  hideStill();
  const started = videoPlayer.play();
  if (started && typeof started.catch === "function") started.catch(() => {});
  updatePlayerControls();
}

function nudgePlayback(direction, frames) {
  if (!videoPlayer.getAttribute("src")) return;
  const file = getCurrentFile();
  const fps = Number(file && file.fps) > 0 ? Number(file.fps) : 25;
  const step = Math.max(8, 1000 / fps) * Math.max(1, frames);
  const target = commitSeek((videoPlayer.currentTime || 0) * 1000 + direction * step);
  scheduleStillAt(target);
}

function seekToExtreme(which) {
  if (!videoPlayer.getAttribute("src")) return;
  const total = videoDurationMs();
  const end = total > 0 ? Math.max(0, total - 1) : (videoPlayer.currentTime || 0) * 1000;
  const target = commitSeek(which === "start" ? 0 : end);
  scheduleStillAt(target);
}

function toggleMute() {
  if (!videoPlayer.getAttribute("src")) return;
  if (videoPlayer.volume === 0) {
    videoPlayer.volume = 0.5;
    videoPlayer.muted = false;
  } else {
    videoPlayer.muted = videoPlayer.muted !== true;
  }
  updatePlayerControls();
}

function setVolumePopoverOpen(open) {
  if (volumePopover) volumePopover.classList.toggle("hidden", !open);
  if (volumeButton) volumeButton.setAttribute("aria-expanded", String(open));
}

function cyclePlaybackRate() {
  if (!videoPlayer.getAttribute("src")) return;
  const current = Number(videoPlayer.playbackRate) || 1;
  const index = SPEED_STEPS.findIndex((value) => Math.abs(value - current) < 0.001);
  videoPlayer.playbackRate = SPEED_STEPS[(index + 1) % SPEED_STEPS.length];
  updatePlayerControls();
}

function toggleFullscreen() {
  if (!videoFrame) return;
  if (document.fullscreenElement) {
    if (typeof document.exitFullscreen === "function") document.exitFullscreen();
    return;
  }
  if (typeof videoFrame.requestFullscreen === "function") videoFrame.requestFullscreen();
}

function trackMsFromClientX(clientX) {
  if (!seekTrack || typeof seekTrack.getBoundingClientRect !== "function") return 0;
  const rect = seekTrack.getBoundingClientRect();
  const width = Number(rect && rect.width) || 0;
  if (width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (Number(clientX) - rect.left) / width));
  const total = videoDurationMs();
  return Math.round(ratio * (total > 0 ? total : 0));
}

function beginScrub(event) {
  if (!videoPlayer.getAttribute("src")) return;
  if (event && typeof event.button === "number" && event.button > 0) return;
  scrubState = {
    ms: trackMsFromClientX(event ? event.clientX : 0),
    wasPlaying: isVideoPlaying(),
    pointerId: event ? event.pointerId : undefined
  };
  // 拖动期间先收起定格帧，否则看到的还是上一张图。
  hideStill();
  if (scrubState.wasPlaying) videoPlayer.pause();
  if (seekTrack) {
    seekTrack.classList.add("scrubbing");
    if (scrubState.pointerId !== undefined && typeof seekTrack.setPointerCapture === "function") {
      try {
        seekTrack.setPointerCapture(scrubState.pointerId);
      } catch (error) {
        /* 没有指针捕获的环境（测试桩）忽略 */
      }
    }
  }
  syncTransport(scrubState.ms);
  if (event && typeof event.preventDefault === "function") event.preventDefault();
}

function moveScrub(event) {
  if (!scrubState) return;
  scrubState.ms = trackMsFromClientX(event ? event.clientX : 0);
  syncTransport(scrubState.ms);
}

function endScrub(event) {
  if (!scrubState) return;
  const { ms, wasPlaying, pointerId } = scrubState;
  scrubState = null;
  if (seekTrack) {
    seekTrack.classList.remove("scrubbing");
    if (pointerId !== undefined && typeof seekTrack.releasePointerCapture === "function") {
      try {
        seekTrack.releasePointerCapture(pointerId);
      } catch (error) {
        /* 同上 */
      }
    }
  }
  const target = commitSeek(ms);
  if (wasPlaying) {
    const started = videoPlayer.play();
    if (started && typeof started.catch === "function") started.catch(() => {});
  } else {
    scheduleStillAt(target);
  }
  updatePlayerControls();
}

function bindPlayerControls() {
  videoPlayer.volume = 0.5;
  setVolumePopoverOpen(false);
  if (playPauseButton) playPauseButton.addEventListener("click", togglePlayback);
  if (volumeButton) volumeButton.addEventListener("click", () => {
    setVolumePopoverOpen(volumeButton.getAttribute("aria-expanded") !== "true");
  });
  if (volumeControl) {
    document.addEventListener("pointerdown", (event) => {
      if (!volumeControl.contains(event.target)) setVolumePopoverOpen(false);
    });
    volumeControl.addEventListener("focusout", (event) => {
      if (!volumeControl.contains(event.relatedTarget)) setVolumePopoverOpen(false);
    });
    volumeControl.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && volumeButton.getAttribute("aria-expanded") === "true") {
        event.stopPropagation();
        setVolumePopoverOpen(false);
        volumeButton.focus();
      }
    });
  }
  if (muteButton) muteButton.addEventListener("click", toggleMute);
  if (speedButton) speedButton.addEventListener("click", cyclePlaybackRate);
  if (stillCloseButton) stillCloseButton.addEventListener("click", hideStill);
  const fullscreenButton = $("#fullscreenButton");
  if (fullscreenButton) fullscreenButton.addEventListener("click", toggleFullscreen);
  if (volumeRange) {
    volumeRange.addEventListener("input", (event) => {
      const level = Math.max(0, Math.min(1, (Number(event.target.value) || 0) / 100));
      videoPlayer.muted = level === 0;
      videoPlayer.volume = level;
      updatePlayerControls();
    });
  }
  if (seekTrack) {
    seekTrack.addEventListener("pointerdown", beginScrub);
    seekTrack.addEventListener("pointermove", moveScrub);
    seekTrack.addEventListener("pointerup", endScrub);
    seekTrack.addEventListener("pointercancel", endScrub);
  }
}

function isTextEntry(target) {
  if (!target) return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable === true;
}

function anyModalOpen() {
  return [onboardingModal, errorModal, settingsModal, aboutModal]
    .some((modal) => modal && !modal.classList.contains("hidden"));
}

// 落点往字幕里偏一帧，别正好压在字幕刚出现的那一帧边界上。
function cueTargetMs(cue) {
  const fps = Number(cue.fps) > 0 ? Number(cue.fps) : 25;
  const frameMs = Math.min(200, Math.max(8, 1000 / fps));
  const span = Math.max(0, cue.endMs - cue.startMs);
  const advanceMs = Math.min(frameMs, Math.max(0, span - frameMs));
  return Math.max(0, cue.startMs + advanceMs);
}

function seekToCue(cue, options = {}) {
  if (!cue) return false;
  const targetMs = cueTargetMs(cue);
  const file = getCurrentFile();
  // 定格帧不依赖播放器重绘，拿不到预览也能看（mkv/avi 就是这种情况）。
  if (file) requestCueFrame(file, cue, targetMs);
  if (!videoPlayer.src) {
    if (options.notify) showToast(t("预览还没就绪，暂时无法定位到该字幕"));
    return false;
  }
  // 关掉原生控件、定格帧盖在画面里之后，不再需要"补播一帧"那套绕法：
  // 暂停 + seek，剩下的交给 stillOverlay。
  if (typeof videoPlayer.pause === "function") videoPlayer.pause();
  commitSeek(targetMs);
  return true;
}

function updateVideoTime() {
  const seconds = videoPlayer.currentTime || 0;
  $("#currentVideoTime").textContent = secondsToClock(seconds);
  updateTimelinePlayhead(seconds * 1000);
  if (state.settings.followPlayback === false) return;
  // 跟随播放：高亮当前播放到的字幕并滚动到可见位置，方便边看边校。
  const cue = cueAtTime(getCurrentSubtitles(), seconds * 1000);
  if (!cue || cue.id === state.activeSubtitleId) return;
  setActiveSubtitle(cue.id);
  updateRowHighlight();
  scrollCueRowIntoView(cue.id);
}

// 内置播放器放不了（或用户就要用外部播放器）时，用系统播放器定位到当前字幕。
async function openCurrentInPlayer() {
  const file = getCurrentFile();
  if (!file || !file.path) {
    showToast(t("请先选择视频任务"));
    return;
  }
  if (!window.subtitleApp || !window.subtitleApp.openInPlayer) {
    showToast(t("当前环境不支持调用外部播放器"));
    return;
  }
  const active = getCurrentSubtitles().find((item) => item.id === state.activeSubtitleId);
  const ms = active ? active.startMs : (videoPlayer.currentTime || 0) * 1000;
  const result = await window.subtitleApp.openInPlayer({
    videoPath: file.path,
    seconds: Math.max(0, Math.floor(ms / 1000))
  });
  if (result && result.ok) showToast(t("已用 {0} 打开", [result.player]));
  else showToast(t("未能打开外部播放器"));
}

function defaultSrtName(file) {
  return `${String(file?.name || "subtitle").replace(/\.[^.]+$/, "")}.srt`;
}

// 导出是"一次调用写完所有文件"，没有百分比可报：用忙碌态（按钮禁用 + aria-busy +
// 文案）说明还在写盘，避免看起来像界面卡住。导出期间两个导出按钮都禁掉，免得
// 再点一次叠出第二个写盘请求。
let exportInFlight = null;

function setExportBusy(kind, busy) {
  if (busy) exportInFlight = kind;
  else if (exportInFlight === kind) exportInFlight = null;
  const current = exportInFlight;
  const items = [
    { kind: "current", button: $("#exportButton"), label: $("#exportButtonLabel"), get text() { return t("导出当前 SRT"); } },
    { kind: "batch", button: $("#batchExportButton"), label: $("#batchExportButtonLabel"), get text() { return t("批量导出 SRT"); } }
  ];
  items.forEach((item) => {
    if (!item.button) return;
    const own = item.kind === current;
    item.button.disabled = Boolean(current);
    item.button.classList.toggle("busy", own);
    if (own) item.button.setAttribute("aria-busy", "true");
    else item.button.removeAttribute("aria-busy");
    if (item.label) item.label.textContent = own ? t("导出中…") : item.text;
  });
}

async function exportCurrentSrt() {
  if (exportInFlight) return;
  const file = getCurrentFile();
  if (!file || file.cues.length === 0) {
    showToast(t("暂无可导出的字幕"));
    return;
  }
  const defaultName = defaultSrtName(file);
  setExportBusy("current", true);
  try {
    // 后端写的是它手上那份 cues，所以先落盘还没回传的编辑。
    await flushPendingCues();

    if (state.backend.ready && window.subtitleApp?.chooseSrtPath) {
      const target = await window.subtitleApp.chooseSrtPath(defaultName);
      if (!target) return;
      // 交给后端写盘：与自动落盘走同一套格式（含 BOM），不会出现两份不一样的 SRT。
      await window.ocrSession.writeSrt(file.id, target);
      clearWriteError(file.id);
      showToast(t("已导出 SRT"), {
        get label() { return t("打开所在文件夹"); },
        onClick: () => window.subtitleApp.revealPath(target)
      });
      return;
    }
    downloadSrt(defaultName, buildSrtOffline(file.cues));
  } catch (error) {
    showError({ code: error.code, message: t("导出失败：{0}", [error.message]), detail: error.detail });
  } finally {
    setExportBusy("current", false);
  }
}

// 批量导出的失败明细：一个文件一行（视频名 + 后端给的 message/detail）。
function showExportFailures(failed) {
  const lines = failed.map((item) => {
    const file = state.files.find((entry) => entry.id === item.taskId);
    const name = (file && file.name) || item.taskId;
    const error = item.error || {};
    return `${name}：${error.message || t("写入失败")}${error.detail ? `（${error.detail}）` : ""}`;
  });
  showError({
    code: (failed[0] && failed[0].error && failed[0].error.code) || "E_OUTPUT_WRITE",
    message: t("{0} 个字幕文件没能写出", [failed.length]),
    detail: lines.join("\\n")
  });
}

// 批量导出：每个视频一个文件，写到各自的视频目录（后端负责唯一命名）。
async function exportBatchSrt() {
  if (exportInFlight) return;
  const files = state.files.filter((file) => file.cues.length > 0);
  if (files.length === 0) {
    showToast(t("暂无可导出的批量任务"));
    return;
  }
  try {
    setExportBusy("batch", true);
    showToast(t("正在导出 {0} 个视频的字幕…", [files.length]));
    // 同上：先把防抖里的编辑交给后端，批量导出才是"最新的结果"。
    await flushPendingCues();
    if (!state.backend.ready) {
      files.forEach((file) => downloadSrt(defaultSrtName(file), buildSrtOffline(file.cues)));
      return;
    }
    // 目录留空时后端写回各自的视频目录；用户设了输出目录就统一写到那里。
    const result = await window.ocrSession.writeBatch(
      files.map((file) => file.id), state.settings.outputDir || null);
    const written = result.written || [];
    written.forEach((item) => {
      const file = state.files.find((entry) => entry.id === item.taskId);
      if (!file) return;
      file.outputPath = item.path;
      clearWriteError(file.id);
    });
    // 失败的要能看出是哪个视频、为什么——只报个数等于没提示。
    const failed = result.failed || [];
    failed.forEach((item) => {
      const file = state.files.find((entry) => entry.id === item.taskId);
      if (!file) return;
      file.writeError = item.error || { code: "E_OUTPUT_WRITE", get message() { return t("写入失败"); } };
    });
    renderFiles();
    if (written.length) {
      showToast(t("已导出 {0} 个 SRT{1}", [written.length, failed.length ? t("，{0} 个失败", [failed.length]) : ""]), {
        label: failed.length ? t("查看失败原因") : t("打开所在文件夹"),
        onClick: () => (failed.length
          ? showExportFailures(failed)
          : window.subtitleApp.revealPath(written[0].path))
      });
    } else if (failed.length) {
      showExportFailures(failed);
    } else {
      showToast(t("没有可写出的字幕文件"));
    }
  } catch (error) {
    showError({ code: error.code, message: t("批量导出失败：{0}", [error.message]) });
  } finally {
    setExportBusy("batch", false);
  }
}

function downloadSrt(name, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

// 仅在浏览器预览（没有后端）时使用；桌面版一律由后端生成。
function buildSrtOffline(cues) {
  return cues
    .map((item, index) => `${index + 1}\n`
      + `${ocrSession.formatTimestamp(item.startMs)} --> ${ocrSession.formatTimestamp(item.endMs)}\n`
      + `${String(item.text).trim() || " "}`)
    .join("\n\n") + "\n";
}

function secondsToClock(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showToast(message, action) {
  const toast = $("#toast");
  toast.textContent = message;
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      toast.classList.remove("visible");
      action.onClick();
    });
    toast.appendChild(button);
  }
  toast.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toast.classList.remove("visible"), action ? 6000 : 1800);
}

function withUiLanguageUtm(url) {
  const link = new URL(url);
  link.searchParams.set("utm_content", state.settings.uiLanguage === "en" ? "en" : "zh-CN");
  return link.toString();
}

function openLink(url) {
  if (window.subtitleApp?.openExternal) {
    window.subtitleApp.openExternal(url);
    return;
  }
  window.open(url, "_blank");
}

init();
