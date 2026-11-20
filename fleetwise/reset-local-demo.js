// Clear the old records the owner asked to remove from this local demo.
// This runs before login and the dashboard read their saved information.
(() => {
  const resetMarker = "fleetwise-local-reset-2026-11-16";

  try {
    // Only this local project copy may reset its data; hosted copies skip this step.
    const requestedPath = "/c:/users/bangi/codes ni aljon/capstone project/fleetwise/index.html";
    const isRequestedCopy = window.location.protocol === "file:" &&
      decodeURIComponent(window.location.pathname).toLowerCase() === requestedPath;
    if (!isRequestedCopy || localStorage.getItem(resetMarker) === "done") return;

    // All entered Fleetwise records live in this one storage entry.
    localStorage.removeItem("fleetwise-v1");

    // Remember that the cleanup is finished so new records survive future refreshes.
    localStorage.setItem(resetMarker, "done");
  } catch (error) {
    console.warn("Could not clear the local Fleetwise demo records.", error);
  }
})();
