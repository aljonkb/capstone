// Keep the color choice in its own little drawer, separate from fleet records.
(() => {
  const storageKey = "fleetwise-theme";

  // Only the two choices we offer are allowed; anything else becomes light mode.
  function applyTheme(value) {
    const theme = value === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    const browserColor = document.querySelector('meta[name="theme-color"]');
    if (browserColor) browserColor.content = theme === "dark" ? "#10213c" : "#123b70";

    // Keep an open Settings dropdown in step with another Fleetwise tab.
    const selector = document.getElementById("appearanceTheme");
    if (selector) selector.value = theme;
  }

  // Reading a blocked storage drawer should never stop the login page from opening.
  let savedTheme = "light";
  try {
    savedTheme = localStorage.getItem(storageKey);
  } catch {}
  applyTheme(savedTheme);

  window.FleetwiseTheme = {
    get: () => document.documentElement.dataset.theme,
    set(theme) {
      if (theme !== "light" && theme !== "dark") return false;
      applyTheme(theme);
      try {
        localStorage.setItem(storageKey, theme);
        return true;
      } catch {
        // The colors still change now, even if this browser cannot remember them.
        return false;
      }
    },
  };

  // When another tab changes or clears this preference, use the same colors here.
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null) {
      try {
        if (event.storageArea === localStorage) applyTheme(event.newValue);
      } catch {}
    }
  });
})();
