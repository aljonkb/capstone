// Login-only code is isolated here so a dashboard error cannot disable sign-in.
(() => {
  const form = document.getElementById("loginForm");
  const error = document.getElementById("loginError");
  const stationField = document.getElementById("stationField");
  let selectedRole = "admin";
  const defaultStations = ["Central Office", "Station 01", "Station 02", "Station 03", "Station 04"];
  let stations = defaultStations;
  try {
    const saved = JSON.parse(localStorage.getItem("fleetwise-v1") || "{}");
    if (Array.isArray(saved.stations)) stations = saved.stations;
  } catch {}
  const stationSelect = document.getElementById("loginStation");
  stationSelect.replaceChildren(...stations.map((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    return option;
  }));
  function loginName(name) {
    if (/^central office$/i.test(name)) return "central";
    const number = name.match(/^station\s*0*(\d+)$/i);
    return number ? "station" + number[1].padStart(2, "0") : name.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function chooseRole(role) {
    selectedRole = role;
    document.querySelectorAll("[data-login-role]").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.loginRole === role);
    });
    stationField.classList.toggle("hidden", role !== "station");
    error.textContent = "";
  }

  // Switch the visible form fields when the user picks an account type.
  document.querySelectorAll("[data-login-role]").forEach((tab) => {
    tab.addEventListener("click", () => chooseRole(tab.dataset.loginRole));
  });

  // Fill in a known demo account without making the user type credentials.
  document.querySelectorAll("[data-demo-login]").forEach((button) => {
    button.addEventListener("click", () => {
      const username = button.dataset.demoLogin;
      const isStation = username !== "admin";
      chooseRole(isStation ? "station" : "admin");
      document.getElementById("loginUsername").value = username;
      document.getElementById("loginPassword").value = isStation
        ? "station123"
        : "admin123";
      if (isStation) {
        document.getElementById("loginStation").value = "Station 01";
      }
    });
  });

  // Check demo credentials, then ask app.js to reveal the fleet workspace.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const username = document
      .getElementById("loginUsername")
      .value.trim()
      .toLowerCase();
    const password = document.getElementById("loginPassword").value;
    const accounts = Object.fromEntries(stations.map((name) => [loginName(name), name]));

    if (selectedRole === "admin") {
      if (username !== "admin" || password !== "admin123") {
        error.textContent =
          "Use the Fill admin demo button, or enter admin / admin123.";
        return;
      }
      window.fleetwiseOnLogin("admin", null);
      return;
    }

    const assignedStation = accounts[username];
    const chosenStation = document.getElementById("loginStation").value;
    if (
      !assignedStation ||
      assignedStation !== chosenStation ||
      password !== "station123"
    ) {
      error.textContent =
        "Use the Fill Station 01 demo button, or enter a matching station account and station123.";
      return;
    }
    window.fleetwiseOnLogin("station", assignedStation);
  });
})();
