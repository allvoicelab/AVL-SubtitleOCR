/* Runs before the app, so saved English preferences never flash Chinese labels. */
(function () {
  let saved;
  try { saved = JSON.parse(localStorage.getItem("subtitle-proofreader.settings") || "null"); } catch (_) {}
  // A saved application preference wins. Otherwise use the language chosen in
  // the installer (written by NSIS before the first launch).
  let initialLanguage = saved?.uiLanguage;
  if (initialLanguage !== "en" && initialLanguage !== "zh-CN") {
    try { initialLanguage = window.subtitleApp?.getUiLanguage?.(); } catch (_) {}
  }
  const api = createI18n(window.UI_MESSAGES, initialLanguage);
  const attributes = ["title", "aria-label", "placeholder", "alt"];
  api.apply = function (root = document) {
    root.querySelectorAll("[data-i18n]").forEach(element => {
      element.textContent = api.t(element.dataset.i18n);
    });
    root.querySelectorAll("[data-i18n-html]").forEach(element => {
      // Only authored catalog entries contain markup; user text never enters here.
      element.innerHTML = api.t(element.dataset.i18nHtml);
    });
    for (const attribute of attributes) {
      root.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
        element.setAttribute(attribute, api.t(element.getAttribute(`data-i18n-${attribute}`)));
      });
    }
    document.documentElement.lang = api.language === "en" ? "en" : "zh-CN";
  };
  window.uiI18n = api;
  window.t = api.t;
  api.apply();
  // These labels are owned by application state after initial rendering.
  // In particular, the current filename and subtitle overlay are user data.
  for (const id of ["currentFileName", "subtitleOverlay", "videoPickLabel", "pendingSummary", "pendingSelectAllButton", "ocrModeLabel", "cpuThreadsHint", "deviceHint", "loadingTitle", "loadingDetail", "errorTitle", "previewNoticeTitle", "fileSummary", "uiScaleOutput", "timelineCollapseButton", "exportButtonLabel", "batchExportButtonLabel"]) {
    document.getElementById(id)?.removeAttribute("data-i18n");
  }
})();
