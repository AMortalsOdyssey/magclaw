(() => {
  const MAGCLAW_LANGUAGE_KEY = 'magclawLanguage';
  const DEFAULT_LANGUAGE = 'en';

  function normalizeLanguage(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'zh' || raw === 'zh-cn' || raw === 'cn' || raw === 'chinese') return 'zh-CN';
    if (raw === 'en' || raw === 'en-us' || raw === 'english') return 'en';
    return DEFAULT_LANGUAGE;
  }

  function requestedLanguage() {
    try {
      const params = new URLSearchParams(window.location.search);
      const queryLanguage = params.get('lang') || params.get('language');
      if (queryLanguage) return normalizeLanguage(queryLanguage);
    } catch {
      // Keep the stored/default language if URLSearchParams is unavailable.
    }

    try {
      return normalizeLanguage(localStorage.getItem(MAGCLAW_LANGUAGE_KEY) || DEFAULT_LANGUAGE);
    } catch {
      return DEFAULT_LANGUAGE;
    }
  }

  function titleFor(language) {
    const dataset = document.body?.dataset || {};
    if (language === 'zh-CN') return dataset.legalTitleZh || document.title;
    return dataset.legalTitleEn || document.title;
  }

  function applyLegalLanguage(language = requestedLanguage()) {
    const next = normalizeLanguage(language);
    document.documentElement.lang = next === 'zh-CN' ? 'zh-CN' : 'en';
    document.title = titleFor(next);

    document.querySelectorAll('[data-legal-copy]').forEach((section) => {
      section.hidden = normalizeLanguage(section.dataset.legalCopy) !== next;
    });
  }

  applyLegalLanguage();

  window.addEventListener('storage', (event) => {
    if (event.key === MAGCLAW_LANGUAGE_KEY) applyLegalLanguage(event.newValue);
  });
})();
