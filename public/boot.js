// Runs before first paint so the saved theme never flashes the wrong colors.
(function () {
  let theme = null;
  try { theme = localStorage.getItem('recipe-theme'); } catch { /* storage unavailable */ }
  if (theme !== 'light' && theme !== 'dark') theme = 'dark';
  document.documentElement.dataset.theme = theme;
})();
