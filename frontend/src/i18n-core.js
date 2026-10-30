/* Shared renderer/main-process translation helpers. No subtitle data is translated. */
(function (root) {
  function createI18n(messages, initialLanguage = "zh-CN") {
    let language = initialLanguage === "en" ? "en" : "zh-CN";
    const reverse = new Map(Object.entries(messages).map(([zh, en]) => [en, zh]));
    const patterns = Object.entries(messages).filter(([zh]) => /\{\d+\}/.test(zh)).flatMap(([zh, en]) => {
      return [zh, en].map(template => {
        const slots = [];
        const escaped = template.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\d+)\}/g, (_, n) => { slots.push(Number(n)); return "([\\s\\S]*?)"; });
        return { zh, slots, regex: new RegExp("^" + escaped + "$") };
      });
    });
    function t(key, values = []) {
      const canonical = reverse.get(key) || key;
      const template = language === "en" ? (messages[canonical] || canonical) : canonical;
      return template.replace(/\{(\d+)\}/g, (match, index) => values[index] == null ? match : String(values[index]));
    }
    // Task status messages can have been generated before a language switch,
    // or restored from a previous session. Translate only these UI messages.
    function message(value) {
      const text = String(value ?? "");
      if (messages[text] || reverse.has(text)) return t(text);
      for (const pattern of patterns) {
        const match = text.match(pattern.regex);
        if (!match) continue;
        const values = [];
        pattern.slots.forEach((slot, i) => { values[slot] = match[i + 1]; });
        return t(pattern.zh, values);
      }
      return text;
    }
    return { t, message, get language() { return language; }, setLanguage(value) { language = value === "en" ? "en" : "zh-CN"; } };
  }
  if (typeof module === "object" && module.exports) module.exports = { createI18n };
  else root.createI18n = createI18n;
})(typeof window === "object" ? window : globalThis);
