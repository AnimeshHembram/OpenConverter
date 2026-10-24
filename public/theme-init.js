// Applies the saved (or system) theme before first paint, so the page never
// flashes the wrong colours. Kept as a tiny external file because the
// Content-Security-Policy forbids inline scripts. Must match resolveTheme()
// in src/ui/theme.ts.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('openconverter-theme');
  } catch (e) {}
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
  // Match the mobile browser bar to the theme (see THEME_BACKGROUND in theme.ts).
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#ffffff');
})();
