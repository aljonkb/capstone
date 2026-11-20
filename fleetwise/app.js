const KEY = "fleetwise-v1";
let state = load();
if (!Array.isArray(state.stations)) state.stations = ["Central Office", "Station 01", "Station 02", "Station 03", "Station 04"];
if (!Array.isArray(state.feedback)) state.feedback = [];
if (!Array.isArray(state.generatedReports)) state.generatedReports = [];
// Keep administrator requests for station maintenance reports with the fleet data.
if (!Array.isArray(state.reportRequests)) state.reportRequests = [];
// Keep saved forecasts and their reviewed outcomes so the pilot can be evaluated.
if (!Array.isArray(state.maintenancePredictions)) state.maintenancePredictions = [];
// Keep recurring service intervals and their completed-service history.
if (!Array.isArray(state.maintenanceSchedules)) state.maintenanceSchedules = [];
if (!Array.isArray(state.maintenanceScheduleHistory)) state.maintenanceScheduleHistory = [];
// Older repair rows did not record who submitted them; attribute station-assigned legacy rows to that station.
state.repairs.forEach((report) => {
  if (report.submittedByRole || report.adminReadAt) return;
  const vehicle = state.vehicles.find((item) => item.id === report.vehicleId);
  if (!vehicle?.station || vehicle.station === "Unassigned") return;
  report.submittedByRole = "station";
  report.submittedByStation = vehicle.station;
  report.adminReadAt = null;
  report.createdAt ||= report.date ? new Date(report.date + "T12:00:00").toISOString() : new Date().toISOString();
});
let role = null,
  station = null;
let currentNav = "dashboard";
let selectedStationDetail = "";
let editingMaintenanceScheduleId = "";
      // Register the handoff early so a later dashboard error cannot block login.
      window.fleetwiseOnLogin = (signedInRole, signedInStation) => {
        role = signedInRole;
        station = signedInStation;
        document.getElementById("loginScreen").classList.add("hidden");
        document.getElementById("appShell").classList.remove("hidden");
        // Update the top-right account menu for the person who just signed in.
        setProfileMenuOpen(false);
        document.getElementById("logoutBtn").onclick = () => location.reload();
        applyRole();
        render();
        if (role === "station") nav("vehicles");
      };
function load() {
  try {
    return (
      JSON.parse(localStorage.getItem(KEY)) || {
        vehicles: [],
        repairs: [],
      }
    );
  } catch {
    return { vehicles: [], repairs: [] };
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
  render();
  document.querySelector(".live").innerHTML =
    '<span class="dot"></span> Saved on this browser';
}
// Show or hide the account menu and keep its accessibility label in sync.
function setProfileMenuOpen(isOpen) {
  const panel = document.getElementById("profileMenuPanel");
  const button = document.getElementById("profileMenuToggle");
  panel.hidden = !isOpen;
  button.setAttribute("aria-expanded", String(isOpen));
}
function esc(s = "") {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}
function money(n) {
  return (
    "₱" + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 0 })
  );
}
// Estimate distance traveled from odometer readings submitted with repair reports.
function odometerDistance(vehicleId) {
  const readings = state.repairs
    .filter((report) => report.vehicleId === vehicleId && String(report.odometer ?? "").trim() !== "")
    .map((report) => ({ km: Number(report.odometer), date: String(report.date || ""), createdAt: String(report.createdAt || "") }))
    .filter((reading) => Number.isFinite(reading.km) && reading.km >= 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  if (!readings.length) return { latest: null, traveled: 0, readingCount: 0 };
  let traveled = 0;
  for (let index = 1; index < readings.length; index++) {
    const increase = readings[index].km - readings[index - 1].km;
    // Ignore a negative delta, which may come from an odometer reset or data entry mistake.
    if (increase >= 0) traveled += increase;
  }
  return { latest: readings[readings.length - 1].km, traveled, readingCount: readings.length };
}
function formatDistance(kilometers) {
  return `${Number(kilometers || 0).toLocaleString("en-PH", { maximumFractionDigits: 1 })} km`;
}
function age(v) {
  if (!v.acquired) return null;
  let d = new Date(v.acquired),
    now = new Date();
  return Math.max(0, (now - d) / (365.2425 * 864e5));
}
function yrSpend(id) {
  let y = new Date().getFullYear();
  return state.repairs
    .filter((r) => r.vehicleId === id && new Date(r.date).getFullYear() === y)
    .reduce((a, r) => a + Number(r.cost || 0), 0);
}
// Calculate the table's repair total using the selected time window.
function repairSpend(id, period = "ytd") {
  const now = new Date();
  const start = period === "month"
    ? new Date(now.getFullYear(), now.getMonth(), 1)
    : period === "year"
      ? new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
      : new Date(now.getFullYear(), 0, 1);
  return state.repairs.filter((r) => {
    if (r.vehicleId !== id) return false;
    if (period === "all") return true;
    const date = new Date((r.date || "") + "T00:00:00");
    return !Number.isNaN(date.getTime()) && date >= start && date <= now;
  }).reduce((sum, r) => sum + Number(r.cost || 0), 0);
}
function ratio(v) {
  let s = yrSpend(v.id);
  return v.replacementCost ? s / Number(v.replacementCost) : 0;
}
function lifeLeft(v) {
  let a = age(v);
  return a == null || !v.usefulLife ? null : Number(v.usefulLife) - a;
}
function inWatch(v) {
  return (lifeLeft(v) != null && lifeLeft(v) <= 1) || ratio(v) >= 0.75;
}
// Take an administrator from a dashboard alert to the matching fleet record.
function viewVehicleFromAlert(vehicleId) {
  if (role !== "admin") return;
  const vehicle = state.vehicles.find((item) => item.id === vehicleId);
  if (!vehicle) return toast("That vehicle could not be found.");
  nav("vehicles");
  showDetail(vehicleId);
}
// Build an explainable early-warning score from maintenance and asset history.
// This is a transparent pilot score, not a trained machine-learning model.
function maintenanceForecast(vehicle) {
  const now = Date.now();
  const yearAgo = now - 365.25 * 86400000;
  const recentReports = state.repairs.filter((report) => {
    if (report.vehicleId !== vehicle.id || !report.date) return false;
    const timestamp = new Date(report.date + "T12:00:00").getTime();
    return Number.isFinite(timestamp) && timestamp >= yearAgo && timestamp <= now;
  });
  const recentSpend = recentReports.reduce((sum, report) => sum + Number(report.cost || 0), 0);
  const replacementCost = Number(vehicle.replacementCost || 0);
  const repairRatio = replacementCost > 0 ? recentSpend / replacementCost : 0;
  const remainingLife = lifeLeft(vehicle);
  const categoryCounts = {};
  recentReports.forEach((report) => {
    const category = String(report.category || "").trim().toLowerCase();
    if (category) categoryCounts[category] = (categoryCounts[category] || 0) + 1;
  });
  const repeatedRepair = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];
  const odometer = odometerDistance(vehicle.id);
  let score = 0;
  const reasons = [];

  if (vehicle.status === "Maintenance") {
    score += 15;
    reasons.push("Currently marked under maintenance");
  }
  if (remainingLife !== null && remainingLife <= 0) {
    score += 35;
    reasons.push("Recorded economic useful life has been reached");
  } else if (remainingLife !== null && remainingLife <= 1) {
    score += 25;
    reasons.push("Useful life is within one year of its limit");
  } else if (remainingLife !== null && remainingLife <= 2) {
    score += 12;
    reasons.push("Useful life is within two years of its limit");
  }
  if (repairRatio >= 1) {
    score += 30;
    reasons.push("Past-year repairs reached the replacement estimate");
  } else if (repairRatio >= 0.75) {
    score += 22;
    reasons.push("Past-year repairs are at least 75% of replacement cost");
  } else if (repairRatio >= 0.5) {
    score += 12;
    reasons.push("Past-year repairs are at least 50% of replacement cost");
  }
  if (recentReports.length >= 5) {
    score += 20;
    reasons.push(`${recentReports.length} repair reports were recorded in the past year`);
  } else if (recentReports.length >= 3) {
    score += 14;
    reasons.push(`${recentReports.length} repair reports were recorded in the past year`);
  } else if (recentReports.length >= 2) {
    score += 8;
    reasons.push(`${recentReports.length} repair reports were recorded in the past year`);
  }
  if (repeatedRepair && repeatedRepair[1] >= 2) {
    score += 10;
    reasons.push(`${repeatedRepair[1]} reports repeat the ${repeatedRepair[0]} repair category`);
  }

  score = Math.min(100, score);
  const level = score >= 65 ? "High" : score >= 35 ? "Watch" : "Routine";
  const coverage = recentReports.length >= 3 && odometer.readingCount >= 2
    ? "Good history coverage"
    : recentReports.length || odometer.readingCount
      ? "Limited history coverage"
      : "Very limited history";
  const dataWarnings = [];
  if (replacementCost > 0 && recentSpend > replacementCost) {
    dataWarnings.push(`Verify the amounts: past-year repair spend is ${Math.round(repairRatio * 100)}% of the replacement estimate.`);
  }
  return {
    score,
    level,
    reasons: reasons.length ? reasons : ["No elevated risk signals in the recorded history"],
    coverage,
    reportCount: recentReports.length,
    odometerCount: odometer.readingCount,
    recentSpend,
    dataWarnings,
  };
}
// Identify repeated snapshots without deleting or changing the user's saved history.
function findPossibleDuplicateForecasts(predictions) {
  const groups = new Map();
  predictions.forEach((prediction) => {
    const created = new Date(prediction.createdAt);
    const dayKey = Number.isNaN(created.getTime())
      ? String(prediction.createdAt || "unknown")
      : `${created.getFullYear()}-${created.getMonth() + 1}-${created.getDate()}`;
    const key = JSON.stringify([prediction.vehicleId, dayKey, prediction.riskLevel, Number(prediction.score), prediction.reasons || []]);
    groups.set(key, [...(groups.get(key) || []), prediction]);
  });
  const duplicateIds = new Set();
  let extraCount = 0;
  groups.forEach((group) => {
    if (group.length < 2) return;
    extraCount += group.length - 1;
    group.forEach((prediction) => duplicateIds.add(prediction.id));
  });
  return { duplicateIds, extraCount };
}
// Show explainable estimates and let an administrator record forecast outcomes.
function renderPredictiveMaintenance() {
  const root = document.getElementById("predictiveMaintenanceContent");
  if (!root) return;
  const vehicles = state.vehicles
    .filter((vehicle) => vehicle.status !== "Disposed")
    .map((vehicle) => ({ vehicle, forecast: maintenanceForecast(vehicle) }))
    .sort((a, b) => b.forecast.score - a.forecast.score);
  const predictions = state.maintenancePredictions.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const duplicateReview = findPossibleDuplicateForecasts(predictions);
  const unresolved = predictions.filter((prediction) => !prediction.outcome).length;
  const overdueReviews = predictions.filter((prediction) => !prediction.outcome && prediction.reviewBy && new Date(prediction.reviewBy).getTime() < Date.now()).length;
  const issueFound = predictions.filter((prediction) => prediction.outcome === "issue-found").length;
  const noIssueFound = predictions.filter((prediction) => prediction.outcome === "no-issue-found").length;
  const vehicleCards = vehicles.length ? vehicles.map(({ vehicle, forecast }) => {
    const vehiclePredictions = predictions.filter((prediction) => prediction.vehicleId === vehicle.id);
    const pending = vehiclePredictions.find((prediction) => !prediction.outcome);
    const latestPrediction = vehiclePredictions[0];
    const reasons = forecast.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("");
    const pendingReviewDate = pending && new Date(pending.reviewBy);
    const pendingOverdue = pendingReviewDate && !Number.isNaN(pendingReviewDate.getTime()) && Date.now() > pendingReviewDate.getTime();
    const latestReviewDate = latestPrediction && new Date(latestPrediction.reviewBy || new Date(new Date(latestPrediction.createdAt).getTime() + 30 * 86400000));
    const reviewWindowOpen = latestReviewDate && !Number.isNaN(latestReviewDate.getTime()) && Date.now() < latestReviewDate.getTime();
    const lastForecast = pending
      ? `<div class="prediction-pending ${pendingOverdue ? "is-overdue" : ""}">Forecast recorded ${esc(new Date(pending.createdAt).toLocaleDateString("en-PH"))} · ${pendingOverdue ? "review overdue" : `review by ${esc(pendingReviewDate.toLocaleDateString("en-PH"))}`}</div>`
      : reviewWindowOpen
        ? `<div class="prediction-pending">Forecast reviewed · next forecast available ${esc(latestReviewDate.toLocaleDateString("en-PH"))}</div>`
        : `<button class="btn secondary" onclick="recordMaintenanceForecast('${escId(vehicle.id)}')">Record forecast for review</button>`;
    const dataWarnings = forecast.dataWarnings.map((warning) => `<div class="prediction-data-warning">${esc(warning)}</div>`).join("");
    return `<article class="prediction-card"><div class="prediction-card-head"><div><b>${esc(vehicle.name || vehicle.plate || `${vehicle.make || ""} ${vehicle.model || "Vehicle"}`)}</b><small>${esc(vehicle.plate || "No plate")} · ${esc(vehicle.station || "Unassigned")}</small></div><span class="prediction-risk ${forecast.level.toLowerCase()}">${forecast.level} · ${forecast.score}/100</span></div><div class="prediction-meter"><span class="${forecast.level.toLowerCase()}" style="width:${forecast.score}%"></span></div><div class="prediction-card-content"><div><b>Signals from history</b><ul>${reasons}</ul></div><div class="prediction-coverage"><b>${esc(forecast.coverage)}</b><small>${forecast.reportCount} repair report(s) in past year · ${forecast.odometerCount} odometer reading(s)</small>${vehicle.replacementCost ? `<small>Past-year repair spend: ${money(forecast.recentSpend)} of ${money(vehicle.replacementCost)} replacement estimate</small>` : "<small>Add a replacement cost estimate to compare repair spending.</small>"}</div></div>${dataWarnings}<div class="prediction-card-foot"><small>Suggested action: ${forecast.level === "High" ? "schedule an inspection soon" : forecast.level === "Watch" ? "review at the next service check" : "continue routine checks"}. This is a review priority, not a failure probability.</small>${lastForecast}</div></article>`;
  }).join("") : '<div class="empty">Add active fleet assets to see maintenance estimates.</div>';
  const history = predictions.length ? predictions.map((prediction) => {
    const created = new Date(prediction.createdAt).toLocaleString("en-PH", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
    const due = new Date(prediction.reviewBy).toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" });
    const predictionOverdue = !prediction.outcome && prediction.reviewBy && new Date(prediction.reviewBy).getTime() < Date.now();
    const outcome = prediction.outcome === "issue-found" ? "Issue found" : prediction.outcome === "no-issue-found" ? "No issue found" : predictionOverdue ? "Review overdue" : "Awaiting review";
    const outcomeActions = prediction.outcome
      ? `<span class="prediction-outcome ${prediction.outcome}">${outcome} · ${esc(new Date(prediction.outcomeAt).toLocaleDateString("en-PH"))}</span>`
      : `<div class="prediction-outcome-actions"><button class="btn secondary" onclick="recordMaintenanceOutcome('${escId(prediction.id)}','issue-found')">Issue found</button><button class="btn secondary" onclick="recordMaintenanceOutcome('${escId(prediction.id)}','no-issue-found')">No issue found</button></div>`;
    const duplicateTag = duplicateReview.duplicateIds.has(prediction.id) ? '<span class="prediction-duplicate-tag">Possible duplicate snapshot</span>' : "";
    const removeDuplicate = duplicateReview.duplicateIds.has(prediction.id)
      ? `<button class="btn danger" onclick="deleteMaintenanceForecast('${escId(prediction.id)}')">Remove duplicate</button>`
      : "";
    return `<article class="prediction-history-row"><div><b>${esc(prediction.vehicleName || "Vehicle")} · ${esc(prediction.riskLevel)} (${Number(prediction.score)} / 100)</b><small>Forecast ${esc(created)} · review by ${esc(due)} · ${outcome}</small>${duplicateTag}</div><div class="prediction-history-actions">${outcomeActions}${removeDuplicate}</div></article>`;
  }).join("") : '<div class="muted-note">No forecasts recorded yet. Record a forecast to start tracking its outcome.</div>';
  const duplicateNotice = duplicateReview.extraCount
    ? `<div class="prediction-duplicate-notice"><b>${duplicateReview.extraCount} possible duplicate forecast record(s)</b><span>Matching vehicle, date, score, and signals were found. Existing history is preserved; remove only entries you confirm are duplicates.</span></div>`
    : "";
  root.innerHTML = `<div class="prediction-disclaimer"><b>Early-warning pilot</b><span>Scores use transparent rules on useful life, repair spending, repeat repair categories, and current status. They are not generated by a trained AI model and do not predict a guaranteed failure. Forecasts and review outcomes are saved in this browser; those labeled outcomes can support a future trained model once enough consistent history is available. Review the evidence before acting.</span></div><div class="prediction-metrics"><div><small>Forecast records</small><b>${predictions.length}</b></div><div><small>Awaiting review</small><b>${unresolved}</b><span class="prediction-metric-note">${overdueReviews} overdue</span></div><div><small>Issue found</small><b>${issueFound}</b></div><div><small>No issue found</small><b>${noIssueFound}</b></div></div>${duplicateNotice}<div class="prediction-list">${vehicleCards}</div><section class="prediction-history"><div class="prediction-history-head"><h3>Forecast outcome tracking</h3><p>Review each forecast by its due date. Record an outcome before creating the next forecast for that vehicle.</p></div>${history}</section>`;
}
// Save a dated estimate so its later inspection result can be compared.
function recordMaintenanceForecast(vehicleId) {
  if (role !== "admin") return toast("Administrator access is required to record forecasts.");
  const vehicle = state.vehicles.find((item) => item.id === vehicleId && item.status !== "Disposed");
  if (!vehicle) return;
  const vehiclePredictions = state.maintenancePredictions
    .filter((prediction) => prediction.vehicleId === vehicleId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (vehiclePredictions.some((prediction) => !prediction.outcome)) {
    return toast("Record the outcome of the open forecast before creating another.");
  }
  const latestPrediction = vehiclePredictions[0];
  if (latestPrediction) {
    const nextReviewDate = new Date(latestPrediction.reviewBy || new Date(latestPrediction.createdAt).getTime() + 30 * 86400000);
    if (!Number.isNaN(nextReviewDate.getTime()) && Date.now() < nextReviewDate.getTime()) {
      return toast(`A forecast already exists for this vehicle. You can record another after ${nextReviewDate.toLocaleDateString("en-PH")}.`);
    }
  }
  const forecast = maintenanceForecast(vehicle);
  const createdAt = new Date();
  const reviewBy = new Date(createdAt.getTime() + 30 * 86400000);
  state.maintenancePredictions.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    vehicleId,
    vehicleName: `${vehicle.plate || vehicle.name || "Vehicle"} · ${vehicle.make || ""} ${vehicle.model || ""}`.trim(),
    riskLevel: forecast.level,
    score: forecast.score,
    reasons: forecast.reasons,
    createdAt: createdAt.toISOString(),
    reviewBy: reviewBy.toISOString(),
    outcome: "",
    outcomeAt: "",
  });
  save();
  toast("Forecast saved for outcome review.");
}
// Record an inspection result for the selected forecast snapshot.
function recordMaintenanceOutcome(predictionId, outcome) {
  if (role !== "admin") return toast("Administrator access is required to update forecast outcomes.");
  const prediction = state.maintenancePredictions.find((item) => item.id === predictionId);
  if (!prediction || !["issue-found", "no-issue-found"].includes(outcome)) return;
  prediction.outcome = outcome;
  prediction.outcomeAt = new Date().toISOString();
  save();
  toast("Forecast outcome saved.");
}
// Let an administrator remove only after confirming a flagged duplicate snapshot.
function deleteMaintenanceForecast(predictionId) {
  if (role !== "admin") return toast("Administrator access is required to remove forecast records.");
  const prediction = state.maintenancePredictions.find((item) => item.id === predictionId);
  if (!prediction) return;
  if (!window.confirm(`Remove this forecast for ${prediction.vehicleName || "the vehicle"}? This also removes its recorded outcome.`)) return;
  state.maintenancePredictions = state.maintenancePredictions.filter((item) => item.id !== predictionId);
  save();
  toast("Forecast record removed.");
}
// Return the local calendar date in the format used by date inputs.
function localDateValue(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
// Use repair and completed-service readings so a service can start an odometer interval.
function latestVehicleOdometer(vehicleId) {
  const readings = [
    ...state.repairs
      .filter((report) => report.vehicleId === vehicleId && String(report.odometer ?? "").trim() !== "")
      .map((report) => ({ value: Number(report.odometer), date: String(report.date || ""), timestamp: String(report.createdAt || "") })),
    ...state.maintenanceScheduleHistory
      .filter((entry) => entry.vehicleId === vehicleId && entry.completedOdometer != null && String(entry.completedOdometer).trim() !== "")
      .map((entry) => ({ value: Number(entry.completedOdometer), date: String(entry.completedDate || ""), timestamp: String(entry.completedAt || "") })),
  ].filter((reading) => Number.isFinite(reading.value) && reading.value >= 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.timestamp.localeCompare(b.timestamp));
  return readings.length ? readings[readings.length - 1].value : null;
}
// Calculate a recurring schedule's visible state from its chosen interval type.
function maintenanceScheduleStatus(schedule, vehicle) {
  if (schedule.intervalType === "date") {
    if (!schedule.nextDueDate) return { key: "missing", label: "Set due date", detail: "No next due date set" };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueDate = new Date(schedule.nextDueDate + "T00:00:00");
    const daysUntil = Math.round((dueDate - today) / 86400000);
    if (daysUntil < 0) return { key: "overdue", label: "Overdue", detail: `Overdue by ${Math.abs(daysUntil)} day(s)` };
    if (daysUntil === 0) return { key: "due", label: "Due today", detail: "Scheduled for today" };
    if (daysUntil <= 30) return { key: "due-soon", label: "Due soon", detail: `Due in ${daysUntil} day(s)` };
    return { key: "upcoming", label: "Upcoming", detail: `Due in ${daysUntil} day(s)` };
  }
  const currentOdometer = latestVehicleOdometer(vehicle.id);
  if (currentOdometer == null) return { key: "missing", label: "Odometer needed", detail: "Log an odometer reading to check this interval" };
  const remaining = Number(schedule.nextDueOdometer || 0) - currentOdometer;
  if (remaining < 0) return { key: "overdue", label: "Overdue", detail: `${formatDistance(Math.abs(remaining))} past due` };
  if (remaining === 0) return { key: "due", label: "Due now", detail: `Current reading: ${formatDistance(currentOdometer)}` };
  const warningDistance = Math.max(50, Math.min(500, Number(schedule.intervalKm || 0) * 0.1));
  if (remaining <= warningDistance) return { key: "due-soon", label: "Due soon", detail: `${formatDistance(remaining)} remaining` };
  return { key: "upcoming", label: "Upcoming", detail: `${formatDistance(remaining)} remaining` };
}
// Render schedules for administrators or only vehicles assigned to the station user.
function renderMaintenanceSchedule() {
  const list = document.getElementById("maintenanceScheduleList");
  if (!list) return;
  const stationSelect = document.getElementById("scheduleStation");
  const vehicleSelect = document.getElementById("scheduleVehicle");
  const previousStation = stationSelect.value;
  const previousVehicle = vehicleSelect.value;
  const stationNames = [...new Set([...state.stations, ...state.vehicles.map((vehicle) => vehicle.station || "Unassigned")])];
  const stationFilter = document.getElementById("maintenanceScheduleStationFilter");
  const previousFilterStation = stationFilter.value;
  stationFilter.innerHTML = '<option value="">All stations</option>' + stationNames.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
  if (role === "station") {
    stationFilter.value = station || "";
    stationFilter.disabled = true;
  } else {
    stationFilter.disabled = false;
    if (stationNames.includes(previousFilterStation)) stationFilter.value = previousFilterStation;
  }
  const selectedStationFilter = role === "station" ? station : stationFilter.value;
  const vehicleFilter = document.getElementById("maintenanceScheduleVehicleFilter");
  updateMaintenanceScheduleVehicleFilterOptions(vehicleFilter.value);
  const selectedVehicleFilter = vehicleFilter.value;
  stationSelect.innerHTML = '<option value="">Choose a station</option>' + stationNames.map((name) => `<option value="${esc(name)}">${esc(name)}</option>`).join("");
  stationSelect.disabled = role === "station";
  if (role === "station") stationSelect.value = station || "";
  else if (stationNames.includes(previousStation)) stationSelect.value = previousStation;
  updateMaintenanceScheduleVehicleOptions(previousVehicle);

  const schedules = state.maintenanceSchedules
    .map((schedule) => ({ schedule, vehicle: state.vehicles.find((item) => item.id === schedule.vehicleId) }))
    .filter(({ schedule, vehicle }) => vehicle && vehicle.status !== "Disposed" && (
      role === "admin" || (role === "station" && String(vehicle.station || "").toLowerCase() === String(station || "").toLowerCase())
    ) && (!selectedStationFilter || String(vehicle.station || "Unassigned").toLowerCase() === String(selectedStationFilter).toLowerCase())
      && (!selectedVehicleFilter || vehicle.id === selectedVehicleFilter))
    .map((entry) => ({ ...entry, status: maintenanceScheduleStatus(entry.schedule, entry.vehicle) }))
    .sort((a, b) => {
      const order = { overdue: 0, due: 1, "due-soon": 2, missing: 3, upcoming: 4 };
      return order[a.status.key] - order[b.status.key] || String(a.schedule.serviceName).localeCompare(String(b.schedule.serviceName));
    });
  const history = state.maintenanceScheduleHistory
    .filter((entry) => {
      const vehicle = state.vehicles.find((item) => item.id === entry.vehicleId);
      const entryStation = vehicle?.station || entry.station || "Unassigned";
      return (role === "admin" || (role === "station" && vehicle && String(vehicle.station || "").toLowerCase() === String(station || "").toLowerCase()))
        && (!selectedStationFilter || String(entryStation).toLowerCase() === String(selectedStationFilter).toLowerCase())
        && (!selectedVehicleFilter || entry.vehicleId === selectedVehicleFilter);
    })
    .sort((a, b) => String(b.completedDate).localeCompare(String(a.completedDate)));
  const attentionCount = schedules.filter(({ status }) => ["overdue", "due", "due-soon"].includes(status.key)).length;
  const unreadCount = role === "admin"
    ? state.maintenanceScheduleHistory.filter((entry) => isStationSubmittedCompletion(entry) && !entry.adminReadAt).length
    : 0;
  document.getElementById("maintenanceScheduleSummary").textContent = `${schedules.length} schedule(s) · ${attentionCount} due soon or overdue`;
  document.getElementById("maintenanceScheduleBadge").textContent = unreadCount;

  const filter = document.querySelector("[data-schedule-filter].active")?.dataset.scheduleFilter || "all";
  if (filter === "completed") {
    list.innerHTML = renderMaintenanceScheduleHistory(history);
  } else {
    const filtered = filter === "due"
      ? schedules.filter(({ status }) => ["due", "due-soon"].includes(status.key))
      : filter === "overdue"
        ? schedules.filter(({ status }) => status.key === "overdue")
        : schedules;
    list.innerHTML = filtered.length ? filtered.map(({ schedule, vehicle, status }) => {
      const latestCompletion = history.find((entry) => entry.scheduleId === schedule.id);
      const nextDue = schedule.intervalType === "date"
        ? new Date(schedule.nextDueDate + "T00:00:00").toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" })
        : formatDistance(schedule.nextDueOdometer);
      const interval = schedule.intervalType === "date" ? `Every ${Number(schedule.intervalDays)} day(s)` : `Every ${formatDistance(schedule.intervalKm)}`;
      const lastDone = latestCompletion
        ? `Last completed ${new Date(latestCompletion.completedDate + "T00:00:00").toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" })}`
        : "No completion recorded yet";
      const latestUnread = role === "admin" && isStationSubmittedCompletion(latestCompletion) && !latestCompletion.adminReadAt;
      const latestReportView = role === "admin" && latestCompletion
        ? `<button type="button" class="btn secondary schedule-inline-view" onclick="viewMaintenanceCompletion('${escId(latestCompletion.id)}')">View</button>`
        : "";
      const stationActions = role === "station"
        ? `<button type="button" class="btn primary" onclick="completeMaintenanceSchedule('${escId(schedule.id)}')">Submit report</button>`
        : "";
      const adminActions = role === "admin"
        ? `<button type="button" class="btn secondary" onclick="editMaintenanceSchedule('${escId(schedule.id)}')">Edit</button><button type="button" class="btn danger" onclick="deleteMaintenanceSchedule('${escId(schedule.id)}')">Delete</button>`
        : "";
      const latestOdometer = latestVehicleOdometer(vehicle.id);
      return `<article class="maintenance-schedule-card"><div class="maintenance-schedule-card-head"><div><h3>${esc(schedule.serviceName)}</h3><small>${esc(vehicle.plate || vehicle.name || "No plate")} · ${esc(vehicle.make || "")} ${esc(vehicle.model || "")} · ${esc(vehicle.station || "Unassigned")}</small></div><span class="schedule-status ${status.key}">${esc(status.label)}</span></div><div class="maintenance-schedule-facts"><div><small>Next due</small><b>${esc(nextDue)}</b><small>${esc(status.detail)}</small></div><div><small>Repeat interval</small><b>${esc(interval)}</b><small>${esc(lastDone)}${latestUnread ? ' <span class="schedule-unread-badge">Unread</span>' : ""}${latestReportView}</small></div>${schedule.intervalType === "odometer" ? `<div><small>Latest odometer</small><b>${latestOdometer == null ? "Not recorded" : formatDistance(latestOdometer)}</b></div>` : ""}</div><div class="maintenance-schedule-actions">${stationActions}${adminActions}</div></article>`;
    }).join("") : '<div class="empty">No schedules match this filter.</div>';
  }
  const recentHistory = document.getElementById("maintenanceRecentHistory");
  recentHistory.classList.toggle("hidden", filter === "completed");
  document.getElementById("maintenanceScheduleHistory").innerHTML = history.length
    ? renderMaintenanceScheduleHistory(history.slice(0, 5))
    : '<div class="empty">No completed services recorded yet.</div>';
}
// Populate the schedule filter with active vehicles owned by the selected station.
function updateMaintenanceScheduleVehicleFilterOptions(selectedVehicleId = "") {
  const select = document.getElementById("maintenanceScheduleVehicleFilter");
  const stationFilter = document.getElementById("maintenanceScheduleStationFilter");
  if (!select || !stationFilter) return;
  const selectedStation = role === "station" ? station : stationFilter.value;
  const vehicles = state.vehicles.filter((vehicle) => vehicle.status !== "Disposed" &&
    (!selectedStation || String(vehicle.station || "Unassigned").toLowerCase() === String(selectedStation).toLowerCase()));
  select.innerHTML = '<option value="">All vehicles</option>' + vehicles.map((vehicle) => {
    const label = `${vehicle.plate || vehicle.name || "No plate"}${vehicle.model ? ` · ${vehicle.model}` : ""}${!selectedStation ? ` · ${vehicle.station || "Unassigned"}` : ""}`;
    return `<option value="${esc(vehicle.id)}">${esc(label)}</option>`;
  }).join("");
  if (vehicles.some((vehicle) => vehicle.id === selectedVehicleId)) select.value = selectedVehicleId;
}
// Keep the vehicle selector scoped to the station chosen in the schedule form.
function updateMaintenanceScheduleVehicleOptions(selectedVehicleId = "") {
  const stationSelect = document.getElementById("scheduleStation");
  const vehicleSelect = document.getElementById("scheduleVehicle");
  const selectedStation = role === "station" ? station : stationSelect.value;
  const vehicles = state.vehicles.filter((vehicle) => vehicle.status !== "Disposed" &&
    String(vehicle.station || "Unassigned").toLowerCase() === String(selectedStation || "").toLowerCase());
  if (!selectedStation) {
    vehicleSelect.innerHTML = '<option value="">Choose a station first</option>';
    vehicleSelect.disabled = true;
    return;
  }
  vehicleSelect.innerHTML = vehicles.length
    ? '<option value="">Choose a vehicle</option>' + vehicles.map((vehicle) => `<option value="${esc(vehicle.id)}">${esc(vehicle.plate || vehicle.name || "No plate")} · ${esc(vehicle.make || "")} ${esc(vehicle.model || "")}</option>`).join("")
    : '<option value="">No active vehicles at this station</option>';
  vehicleSelect.disabled = vehicles.length === 0;
  if (vehicles.some((vehicle) => vehicle.id === selectedVehicleId)) vehicleSelect.value = selectedVehicleId;
}
// Format saved service completions for the station and administrator history lists.
function renderMaintenanceScheduleHistory(history) {
  if (!history.length) return '<div class="empty">No completed services recorded yet.</div>';
  return history.map((entry) => {
    const vehicle = state.vehicles.find((item) => item.id === entry.vehicleId);
    const date = new Date(entry.completedDate + "T00:00:00").toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" });
    const odo = entry.completedOdometer != null ? ` · ${formatDistance(entry.completedOdometer)}` : "";
    const unread = role === "admin" && isStationSubmittedCompletion(entry) && !entry.adminReadAt;
    const review = role === "admin"
      ? `<div class="schedule-history-review">${unread ? '<span class="schedule-unread-badge">Unread</span>' : '<span class="schedule-status completed">Completed</span>'}<button type="button" class="btn secondary" onclick="viewMaintenanceCompletion('${escId(entry.id)}')">View</button>${unread ? `<button type="button" class="btn secondary" onclick="markMaintenanceCompletionRead('${escId(entry.id)}')">Mark read</button>` : ""}</div>`
      : `<span class="schedule-status completed">Completed</span>`;
    return `<article class="maintenance-history-row"><div><b>${esc(entry.serviceName)} · ${esc(vehicle?.plate || entry.vehicleName || "Vehicle")}</b><small>${esc(date)}${odo} · ${esc(entry.station || vehicle?.station || "Unassigned")}${entry.completedBy ? ` · ${esc(entry.completedBy)}` : ""}</small>${entry.notes ? `<small>${esc(entry.notes)}</small>` : ""}</div>${review}</article>`;
  }).join("");
}
// Legacy entries identify the submitting station by name; new entries store the role explicitly.
function isStationSubmittedCompletion(entry) {
  if (!entry) return false;
  if (entry.completedByRole) return entry.completedByRole === "station";
  return Boolean(entry.completedBy && entry.completedBy !== "Administrator");
}
// Only administrators can clear the unread marker on a station-submitted completion.
function markMaintenanceCompletionRead(completionId) {
  if (role !== "admin") return;
  const entry = state.maintenanceScheduleHistory.find((item) => item.id === completionId);
  if (!entry || !isStationSubmittedCompletion(entry)) return;
  entry.adminReadAt = new Date().toISOString();
  entry.adminReadBy = "Administrator";
  save();
}
// Open the submitted maintenance report; viewing an unread station report marks it read.
function viewMaintenanceCompletion(completionId) {
  if (role !== "admin") return;
  const entry = state.maintenanceScheduleHistory.find((item) => item.id === completionId);
  if (!entry) return toast("That maintenance report could not be found.");
  const vehicle = state.vehicles.find((item) => item.id === entry.vehicleId);
  const reportDate = new Date(entry.completedDate + "T00:00:00").toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric" });
  if (isStationSubmittedCompletion(entry) && !entry.adminReadAt) {
    entry.adminReadAt = new Date().toISOString();
    entry.adminReadBy = "Administrator";
    save();
  }
  modal(
    "Maintenance report details",
    `${esc(vehicle?.plate || entry.vehicleName || "Vehicle")} · ${esc(vehicle?.make || "")} ${esc(vehicle?.model || "")}`,
    `<div class="schedule-completion-details"><div><small>Service item</small><b>${esc(entry.serviceName)}</b></div><div><small>Report date</small><b>${esc(reportDate)}</b></div><div><small>Station</small><b>${esc(entry.station || vehicle?.station || "Unassigned")}</b></div><div><small>Odometer</small><b>${entry.completedOdometer != null ? `${formatDistance(entry.completedOdometer)}` : "Not recorded"}</b></div><div><small>Submitted by</small><b>${esc(entry.completedBy || entry.station || "Station")}</b></div><div class="full"><small>Completion notes</small><p>${entry.notes ? esc(entry.notes) : "No notes provided."}</p></div></div><div class="form-actions"><button type="button" class="btn primary" onclick="closeModal()">Close</button></div>`,
  );
}
// Show the date or odometer inputs that match the selected interval basis.
function updateScheduleIntervalFields() {
  const type = document.getElementById("scheduleIntervalType").value;
  const dateMode = type === "date";
  document.getElementById("scheduleDateFields").classList.toggle("hidden", !dateMode);
  document.getElementById("scheduleOdometerFields").classList.toggle("hidden", dateMode);
  document.getElementById("scheduleNextDueDate").required = dateMode;
  document.getElementById("scheduleIntervalDays").required = dateMode;
  document.getElementById("scheduleNextDueOdometer").required = !dateMode;
  document.getElementById("scheduleIntervalKm").required = !dateMode;
}
// Create a new service interval or save edits made by an administrator.
function saveMaintenanceSchedule(event) {
  event.preventDefault();
  if (role !== "admin") return toast("Administrator access is required to manage service intervals.");
  const form = event.currentTarget;
  const selectedStation = document.getElementById("scheduleStation").value;
  if (!selectedStation) return toast("Choose the station for this service interval.");
  const vehicle = state.vehicles.find((item) => item.id === document.getElementById("scheduleVehicle").value && item.status !== "Disposed" && String(item.station || "Unassigned").toLowerCase() === selectedStation.toLowerCase());
  if (!vehicle) return toast("Choose an active vehicle assigned to the selected station.");
  const type = document.getElementById("scheduleIntervalType").value;
  const scheduleData = {
    station: selectedStation,
    vehicleId: vehicle.id,
    serviceName: document.getElementById("scheduleServiceName").value.trim(),
    intervalType: type,
    intervalDays: type === "date" ? Number(document.getElementById("scheduleIntervalDays").value) : 0,
    intervalKm: type === "odometer" ? Number(document.getElementById("scheduleIntervalKm").value) : 0,
    nextDueDate: type === "date" ? document.getElementById("scheduleNextDueDate").value : "",
    nextDueOdometer: type === "odometer" ? Number(document.getElementById("scheduleNextDueOdometer").value) : 0,
  };
  if (!scheduleData.serviceName) return toast("Enter the maintenance task name.");
  if (type === "date" && (!scheduleData.nextDueDate || scheduleData.intervalDays < 1)) return toast("Enter a due date and a valid day interval.");
  if (type === "odometer" && (!Number.isFinite(scheduleData.nextDueOdometer) || scheduleData.intervalKm < 1)) return toast("Enter a due odometer and a valid kilometer interval.");
  if (editingMaintenanceScheduleId) {
    const existing = state.maintenanceSchedules.find((item) => item.id === editingMaintenanceScheduleId);
    if (!existing) return toast("That maintenance schedule could not be found.");
    Object.assign(existing, scheduleData, { updatedAt: new Date().toISOString() });
  } else {
    state.maintenanceSchedules.push({
      id: crypto.randomUUID(),
      ...scheduleData,
      createdAt: new Date().toISOString(),
      createdBy: role,
    });
  }
  editingMaintenanceScheduleId = "";
  form.reset();
  updateScheduleIntervalFields();
  updateMaintenanceScheduleVehicleOptions();
  document.getElementById("maintenanceScheduleSubmit").textContent = "＋ Add schedule";
  document.getElementById("cancelScheduleEdit").classList.add("hidden");
  document.getElementById("scheduleFormHint").textContent = "Stations can view the schedule and record completed service for their vehicles.";
  save();
  toast("Maintenance schedule saved.");
}
// Load an existing interval into the administrator form for editing.
function editMaintenanceSchedule(scheduleId) {
  if (role !== "admin") return;
  const schedule = state.maintenanceSchedules.find((item) => item.id === scheduleId);
  if (!schedule) return;
  editingMaintenanceScheduleId = scheduleId;
  const vehicle = state.vehicles.find((item) => item.id === schedule.vehicleId);
  const stationSelect = document.getElementById("scheduleStation");
  stationSelect.value = schedule.station || vehicle?.station || "Unassigned";
  updateMaintenanceScheduleVehicleOptions(schedule.vehicleId);
  document.getElementById("scheduleVehicle").value = schedule.vehicleId;
  document.getElementById("scheduleServiceName").value = schedule.serviceName;
  document.getElementById("scheduleIntervalType").value = schedule.intervalType;
  updateScheduleIntervalFields();
  document.getElementById("scheduleNextDueDate").value = schedule.nextDueDate || "";
  document.getElementById("scheduleIntervalDays").value = schedule.intervalDays || "";
  document.getElementById("scheduleNextDueOdometer").value = schedule.nextDueOdometer ?? "";
  document.getElementById("scheduleIntervalKm").value = schedule.intervalKm || "";
  document.getElementById("maintenanceScheduleSubmit").textContent = "Save changes";
  document.getElementById("cancelScheduleEdit").classList.remove("hidden");
  document.getElementById("scheduleFormHint").textContent = "Update the interval details, then save your changes.";
  document.getElementById("maintenanceScheduleForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
// Remove an interval while retaining any completed-service history.
function deleteMaintenanceSchedule(scheduleId) {
  if (role !== "admin") return;
  const schedule = state.maintenanceSchedules.find((item) => item.id === scheduleId);
  if (!schedule || !window.confirm(`Delete the ${schedule.serviceName} schedule? Completed service history will remain.`)) return;
  state.maintenanceSchedules = state.maintenanceSchedules.filter((item) => item.id !== scheduleId);
  if (editingMaintenanceScheduleId === scheduleId) cancelMaintenanceScheduleEdit();
  save();
  toast("Maintenance schedule deleted.");
}
// Record a completed service and advance the recurring schedule to its next interval.
function completeMaintenanceSchedule(scheduleId) {
  if (role !== "station") return toast("Only the assigned station can submit a service completion.");
  const schedule = state.maintenanceSchedules.find((item) => item.id === scheduleId);
  const vehicle = schedule && state.vehicles.find((item) => item.id === schedule.vehicleId);
  if (!schedule || !vehicle || String(vehicle.station || "").toLowerCase() !== String(station || "").toLowerCase()) {
    return toast("That maintenance schedule is not available.");
  }
  const latestOdometer = latestVehicleOdometer(vehicle.id);
  const odometerRequired = schedule.intervalType === "odometer";
  modal(
    "Submit maintenance report",
    `${schedule.serviceName} · ${vehicle.plate || vehicle.name || "Vehicle"}`,
    `<form id="scheduleCompletionForm" class="form"><div class="form-grid"><div class="field"><label>Completion date *</label><input name="completedDate" type="date" required value="${localDateValue()}"></div><div class="field"><label>Odometer (km)${odometerRequired ? " *" : ""}</label><input name="completedOdometer" type="number" min="${latestOdometer ?? 0}" step="1" value="${latestOdometer ?? ""}" ${odometerRequired ? "required" : ""}></div><div class="field full"><label>Completion notes</label><textarea name="notes" placeholder="Work performed, parts used, reference…"></textarea></div></div><div class="form-actions"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn primary">Submit report</button></div></form>`,
  );
  document.getElementById("scheduleCompletionForm").onsubmit = (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const completedOdometer = data.completedOdometer === "" ? null : Number(data.completedOdometer);
    if (odometerRequired && (!Number.isFinite(completedOdometer) || completedOdometer < 0)) return toast("Enter the current odometer reading to advance this interval.");
    if (latestOdometer != null && completedOdometer != null && completedOdometer < latestOdometer) return toast(`Enter an odometer reading of at least ${formatDistance(latestOdometer)}.`);
    const completion = {
      id: crypto.randomUUID(),
      scheduleId: schedule.id,
      vehicleId: vehicle.id,
      vehicleName: vehicle.plate || vehicle.name || "Vehicle",
      station: vehicle.station || "Unassigned",
      serviceName: schedule.serviceName,
      completedDate: data.completedDate,
      completedAt: new Date().toISOString(),
      completedOdometer,
      notes: String(data.notes || "").trim(),
      completedBy: station,
      completedByRole: "station",
      adminReadAt: null,
    };
    state.maintenanceScheduleHistory.push(completion);
    if (schedule.intervalType === "date") {
      const nextDate = new Date(data.completedDate + "T00:00:00");
      nextDate.setDate(nextDate.getDate() + Number(schedule.intervalDays));
      schedule.nextDueDate = localDateValue(nextDate);
    } else {
      schedule.nextDueOdometer = completedOdometer + Number(schedule.intervalKm);
    }
    schedule.lastCompletedDate = data.completedDate;
    schedule.lastCompletedOdometer = completedOdometer;
    save();
    closeModal();
    toast("Maintenance report submitted and the next interval scheduled.");
  };
}
// Exit edit mode without changing the saved schedule.
function cancelMaintenanceScheduleEdit() {
  editingMaintenanceScheduleId = "";
  document.getElementById("maintenanceScheduleForm").reset();
  updateScheduleIntervalFields();
  updateMaintenanceScheduleVehicleOptions();
  document.getElementById("maintenanceScheduleSubmit").textContent = "＋ Add schedule";
  document.getElementById("cancelScheduleEdit").classList.add("hidden");
  document.getElementById("scheduleFormHint").textContent = "Stations can view the schedule and record completed service for their vehicles.";
}
function escId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "");
}
// Return station names for asset, report and feedback dropdowns.
function stationOptions(selected = "", includePrompt = false) {
  const opts = state.stations.map((name) => `<option ${name === selected ? "selected" : ""}>${esc(name)}</option>`).join("");
  const legacy = selected && !state.stations.includes(selected) ? `<option selected>${esc(selected)}</option>` : "";
  return (includePrompt ? '<option value="" disabled selected>Choose station or office</option>' : "") + legacy + opts;
}
function stationLoginName(name) {
  if (/^central office$/i.test(name)) return "central";
  const n = name.match(/^station\s*0*(\d+)$/i);
  return n ? "station" + n[1].padStart(2, "0") : name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
function render() {
  let q = (document.getElementById("searchInput")?.value || "").toLowerCase(),
    tf = document.getElementById("typeFilter")?.value || "all",
    sf = document.getElementById("statusFilter")?.value || "all",
    repairPeriod = document.getElementById("repairPeriodFilter")?.value || "ytd";
  let scoped = state.vehicles.filter(
    (v) =>
      role === "admin" ||
      (station &&
        String(v.station || "").toLowerCase() === station.toLowerCase()),
  );
  let live = scoped.filter((v) => v.status !== "Disposed");
  let watch = live.filter(inWatch);
  const registeredVehicles = scoped.filter((v) => v.type === "Vehicle");
  const registeredMotorcycles = scoped.filter((v) => v.type === "Motorcycle");
  const registeredTotal = registeredVehicles.length + registeredMotorcycles.length;
  document.getElementById("vehicleRegisterCount").innerHTML = `<b>${registeredVehicles.length}</b> registered`;
  document.getElementById("motorcycleRegisterCount").innerHTML = `<b>${registeredMotorcycles.length}</b> registered`;
  document.getElementById("vehicleMixBar").style.width = `${registeredTotal ? registeredVehicles.length / registeredTotal * 100 : 0}%`;
  document.getElementById("motorcycleMixBar").style.width = `${registeredTotal ? registeredMotorcycles.length / registeredTotal * 100 : 0}%`;
  document.getElementById("registerSummaryNote").textContent = registeredTotal ? `${registeredTotal} asset record(s) entered · ${live.length} active · ${scoped.length - live.length} disposed.` : "No fleet records have been entered yet.";
  document.getElementById("vehCount").textContent = live.filter(
    (v) => v.type === "Vehicle",
  ).length;
  document.getElementById("motoCount").textContent = live.filter(
    (v) => v.type === "Motorcycle",
  ).length;
  document.getElementById("watchCount").textContent = watch.length;
  let scopedIds = new Set(scoped.map((v) => v.id));
  let total = state.repairs
    .filter(
      (r) =>
        scopedIds.has(r.vehicleId) &&
        new Date(r.date).getFullYear() === new Date().getFullYear(),
    )
    .reduce((a, r) => a + Number(r.cost || 0), 0);
  document.getElementById("spendCount").textContent = money(total);
  document.getElementById("planBadge").textContent = watch.length;
  let list = scoped.filter(
    (v) =>
      (tf === "all" || v.type === tf) &&
      (sf === "all" || v.status === sf) &&
      [v.name, v.plate, v.station, v.make, v.model]
        .join(" ")
        .toLowerCase()
        .includes(q),
  );
  if (currentNav === "planning") list = list.filter(inWatch);
  if (currentNav === "repairs")
    list = list.filter((v) => state.repairs.some((r) => r.vehicleId === v.id));
  document.getElementById("fleetBody").innerHTML = list.length
    ? list
        .map((v) => {
          let left = lifeLeft(v),
            status =
              v.status === "Active"
                ? '<span class="tag good">Active</span>'
                : v.status === "Maintenance"
                  ? '<span class="tag warn">Maintenance</span>'
                  : '<span class="tag neutral">Disposed</span>';
          let life =
            left == null
              ? "—"
              : left <= 0
                ? '<span class="tag bad">Life exceeded</span>'
                : left <= 1
                  ? '<span class="tag warn">' +
                    left.toFixed(1) +
                    " yr left</span>"
                  : left.toFixed(1) + " yrs";
          let spend = repairSpend(v.id, repairPeriod);
          const lastReport = state.repairs.filter((r) => r.vehicleId === v.id).sort((a, b) => b.date.localeCompare(a.date))[0];
          const lastReportDate = lastReport?.date ? new Date(lastReport.date + "T00:00:00").toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" }) : "No reports";
          return `<tr><td><div class="unit"><span class="unit-icon">${v.type === "Motorcycle" ? "🏍" : "🚙"}</span><div><b>${esc(v.name || v.make + " " + v.model)}</b><small>${esc(v.plate || "No plate")} · ${esc(v.make || "")} ${esc(v.model || "")}</small></div></div></td><td>${esc(v.type)}</td><td>${esc(v.station || "—")}</td><td>${v.acquired ? new Date(v.acquired + "T00:00:00").toLocaleDateString("en-PH", { month: "short", year: "numeric" }) : "—"}</td><td>${life}</td><td class="cost">${money(spend)}${v.replacementCost && spend / Number(v.replacementCost) >= 0.75 ? '<div><span class="tag ' + (spend / Number(v.replacementCost) >= 1 ? "bad" : "warn") + '">' + Math.round((spend / Number(v.replacementCost)) * 100) + "% of new</span></div>" : ""}</td><td title="${esc(lastReport?.description || "")}">${lastReport ? `<b>${esc(lastReportDate)}</b><small class="last-report-detail">${esc(lastReport.category || "Maintenance")} · ${esc(lastReport.description || "")}</small>` : "—"}</td><td>${status}</td><td><button class="row-btn" title="View asset" onclick="showDetail('${escId(v.id)}')">···</button></td></tr>`;
        })
        .join("")
    : `<tr><td colspan="9" class="empty">${state.vehicles.length ? "No assets match your search." : "Your asset register is ready. Add an acquisition or donation to begin tracking fleet history."}</td></tr>`;
  document.getElementById("recordCount").textContent = state.vehicles.length
    ? `Showing ${list.length} of ${state.vehicles.length} asset records`
    : "No asset records have been entered yet";
  let alerts = watch
    .slice(0, 4)
    .map(
      (v) =>
        `<div class="alert-row"><div class="alert-mark ${lifeLeft(v) <= 0 ? "red" : "amber"}">!</div><div class="alert-copy"><b>${esc(v.name || v.plate || v.make + " " + v.model)}</b><small>${lifeLeft(v) <= 1 ? "Useful life " + (lifeLeft(v) <= 0 ? "exceeded" : "ending soon") : Math.round(ratio(v) * 100) + "% of replacement value spent on repairs this year"}</small></div><span class="alert-cost">${money(yrSpend(v.id))}</span><button type="button" class="btn secondary alert-view" onclick="viewVehicleFromAlert('${escId(v.id)}')">View</button></div>`,
    );
  if (!alerts.length)
    alerts = [
      '<div class="empty" style="padding:18px 8px">No asset alerts yet. Add records with acquisition date, useful life, and replacement cost to enable warnings.</div>',
    ];
  document.getElementById("alertList").innerHTML = alerts.join("");
  renderStationReports();
  renderPredictiveMaintenance();
  renderMaintenanceSchedule();
  renderSelectedStationDetails();
  renderAdminNotifications();
  renderStationCars();
  renderStationReportHistory();
  updateNotificationBell(watch.length);
  if (currentNav === "repairs")
    document.getElementById("tableTitle").textContent =
      "Repair and maintenance history";
  else if (currentNav === "planning")
    document.getElementById("tableTitle").textContent =
      "Replacement planning watchlist";
  else document.getElementById("tableTitle").textContent = "Fleet inventory";
}
// Draw only this station's cars, with report age and status filters.
function renderStationCars() {
  const all = state.vehicles.filter((v) => role === "station" && String(v.station || "").toLowerCase() === String(station || "").toLowerCase());
  const search = (document.getElementById("stationCarSearch")?.value || "").toLowerCase();
  const filter = document.querySelector("[data-car-filter].active")?.dataset.carFilter || "all";
  const ageDays = (v) => { const last = state.repairs.filter((r) => r.vehicleId === v.id).sort((a,b) => b.date.localeCompare(a.date))[0]; return last ? Math.floor((Date.now() - new Date(last.date + "T00:00:00")) / 86400000) : null; };
  const overdue = all.filter((v) => ageDays(v) === null || ageDays(v) >= 30).length;
  const notice = document.getElementById("stationOverdueNotice");
  if (notice) { notice.classList.toggle("ok", overdue === 0); notice.textContent = overdue ? `${overdue} vehicle(s) have no repair report in the last 30+ days. Please submit.` : "All vehicles have a recent repair report."; }
  const list = all.filter((v) => {
    const age = ageDays(v), matchSearch = [v.name,v.plate,v.make,v.model].join(" ").toLowerCase().includes(search);
    return matchSearch && (filter === "all" || (filter === "overdue" && (age === null || age >= 30)) || (filter === "repair" && v.status === "Maintenance"));
  });
  document.getElementById("stationCarList").innerHTML = list.length ? list.map((v) => {
    const age = ageDays(v), reports = state.repairs.filter((r) => r.vehicleId === v.id), total = reports.reduce((s,r) => s + Number(r.cost || 0), 0);
    const status = v.status === "Maintenance" ? "Under repair" : age === null || age >= 30 ? `Overdue ${age === null ? "30+" : age}d` : `OK ${30-age}d`;
    const cls = v.status === "Maintenance" ? "repair" : age === null || age >= 30 ? "overdue" : "";
    const last = reports.sort((a,b) => b.date.localeCompare(a.date))[0];
    const reportDate = last ? new Date(last.date + "T00:00:00").toLocaleDateString() : "No report yet";
    return `<article class="station-car-card"><div><div class="station-car-title">${esc(v.plate || "No plate")} · ${esc(v.make || "")} ${esc(v.model || v.name || "Vehicle")}</div><div class="station-car-meta">Last report: ${esc(reportDate)}${age === null ? "" : ` · ${age} days ago`} · ${reports.length} report(s) · ${money(total)}</div></div><span class="station-car-status ${cls}">${esc(status)}</span><div class="station-car-actions"><button class="btn secondary" onclick="addRepair('${escId(v.id)}')">＋ Log repair</button></div></article>`;
  }).join("") : '<div class="empty">No station vehicles match this filter.</div>';
}
// Show the signed-in station's complete maintenance report history, newest first.
function renderStationReportHistory() {
  const select = document.getElementById("reportCarSelect");
  const rows = document.getElementById("stationReportHistory");
  const summary = document.getElementById("stationHistorySummary");
  const requestsBox = document.getElementById("stationReportRequests");
  if (!select || !rows || !summary) return;
  const cars = state.vehicles.filter((v) => role === "station" && String(v.station || "").toLowerCase() === String(station || "").toLowerCase());
  select.innerHTML = cars.map((v) => `<option value="${esc(v.id)}">${esc(v.plate || "No plate")} · ${esc(v.make || "")} ${esc(v.model || v.name || "Vehicle")}</option>`).join("");
  // Requests are visible only to the station they were sent to.
  if (requestsBox) {
    const pending = state.reportRequests
      .filter((request) => request.station === station && request.status === "pending")
      .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
    requestsBox.classList.toggle("hidden", role !== "station" || pending.length === 0);
    requestsBox.innerHTML = pending.map((request) => {
      const requestedDate = new Date(request.requestedAt).toLocaleDateString("en-PH", { day: "numeric", month: "short", year: "numeric" });
      return `<article class="station-request-card"><div><b>Maintenance report requested</b><small>Requested ${esc(requestedDate)} · Please submit a current report for one of your vehicles.</small></div><button class="btn primary" onclick="startReportForRequest('${escId(request.id)}')" ${cars.length ? "" : "disabled"}>Start report</button></article>`;
    }).join("");
  }
  const ids = new Set(cars.map((v) => v.id));
  const history = state.repairs
    .filter((repair) => ids.has(repair.vehicleId))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const currentMonth = new Date().toLocaleDateString("en-PH", { month: "long", year: "numeric" });
  summary.textContent = `${history.length} submitted report(s) · Current month: ${currentMonth}`;
  rows.innerHTML = history.length ? history.map((repair) => {
    const vehicle = cars.find((item) => item.id === repair.vehicleId);
    return `<div class="current-report-row"><span><b>${esc(vehicle?.plate || vehicle?.name || "Vehicle")} · ${esc(repair.category || "Maintenance")}</b><small>${esc(repair.date || "Date not recorded")} · ${esc(repair.description || "No description")}</small></span><span>${money(repair.cost)}<small>${esc(repair.odometer || "—")} km</small><button type="button" class="btn secondary report-detail-button" onclick="showStationReportDetails('${escId(repair.id)}')">View details</button></span></div>`;
  }).join("") : '<div class="empty">No maintenance reports have been submitted for this station yet.</div>';
}
// Let station users inspect the complete saved record for their own vehicle reports.
function showStationReportDetails(reportId) {
  if (role !== "station" && role !== "admin") return;
  const report = state.repairs.find((item) => item.id === reportId);
  const vehicle = report && state.vehicles.find((item) => item.id === report.vehicleId);
  if (!report || !vehicle || (role === "station" && String(vehicle.station || "").toLowerCase() !== String(station || "").toLowerCase())) {
    return toast("That report is not available.");
  }
  // Opening a station-submitted report from the admin detail page marks it reviewed.
  if (role === "admin" && report.submittedByRole === "station" && !report.adminReadAt) {
    report.adminReadAt = new Date().toISOString();
    save();
  }
  const reportDate = report.date
    ? new Date(report.date + "T00:00:00").toLocaleDateString("en-PH", { day: "numeric", month: "long", year: "numeric" })
    : "Not recorded";
  // Only display common raster image data URLs saved from the receipt/photo input.
  const photoUrl = typeof report.photo === "string" && /^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(report.photo)
    ? esc(report.photo)
    : "";
  const photoSection = photoUrl
    ? `<div class="repair-detail-section"><b>Receipt / work order photo</b><img class="repair-detail-photo" src="${photoUrl}" alt="Receipt or work order attached to this report"></div>`
    : `<div class="repair-detail-section"><b>Receipt / work order photo</b><p>${report.photo ? "An attachment is saved, but this image type cannot be previewed here." : "No photo attached."}</p></div>`;
  modal(
    "Maintenance report details",
    `${esc(vehicle.plate || "No plate")} · ${esc(vehicle.make || "")} ${esc(vehicle.model || vehicle.name || "Vehicle")}`,
    `<div class="form"><div class="detail-cards"><div class="detail-card"><small>Report date</small><b>${esc(reportDate)}</b></div><div class="detail-card"><small>Category</small><b>${esc(report.category || "Maintenance")}</b></div><div class="detail-card"><small>Repair cost</small><b>${money(report.cost)}</b></div><div class="detail-card"><small>Odometer</small><b>${esc(report.odometer || "—")} km</b></div><div class="detail-card"><small>Funding source</small><b>${esc(report.funding || "Not recorded")}</b></div><div class="detail-card"><small>Days out of service</small><b>${esc(report.days || "0")} day(s)</b></div></div><div class="repair-detail-section"><b>Description</b><p>${esc(report.description || "No description recorded.")}</p></div><div class="repair-detail-section"><b>Service provider / reference</b><p>${esc(report.provider || "Not recorded")}</p></div>${photoSection}<div class="form-actions"><button type="button" class="btn secondary" onclick="downloadMaintenanceReport('${escId(report.id)}')">Download report (.txt)</button><button type="button" class="btn primary" onclick="closeModal()">Close</button></div></div>`,
  );
}
// Download a printable text copy of a report visible to the current user.
function downloadMaintenanceReport(reportId) {
  const report = state.repairs.find((item) => item.id === reportId);
  const vehicle = report && state.vehicles.find((item) => item.id === report.vehicleId);
  if (!report || !vehicle || (role !== "admin" && (role !== "station" || String(vehicle.station || "").toLowerCase() !== String(station || "").toLowerCase()))) {
    return toast("That report is not available.");
  }
  const submittedBy = report.submittedByRole === "station"
    ? `Station staff${report.submittedByStation ? ` · ${report.submittedByStation}` : ""}`
    : report.submittedByRole === "admin" ? "Administrator" : "Not recorded";
  const content = [
    "FLEETWISE MAINTENANCE REPORT",
    "============================",
    `Vehicle: ${vehicle.name || vehicle.make || "Vehicle"}`,
    `Plate / asset number: ${vehicle.plate || "Not recorded"}`,
    `Station / office: ${vehicle.station || "Not recorded"}`,
    `Report date: ${report.date || "Not recorded"}`,
    `Category: ${report.category || "Maintenance"}`,
    `Repair cost: ${money(report.cost)}`,
    `Odometer: ${report.odometer || "Not recorded"} km`,
    `Funding source: ${report.funding || "Not recorded"}`,
    `Days out of service: ${report.days || 0}`,
    `Service provider / reference: ${report.provider || "Not recorded"}`,
    `Submitted by: ${submittedBy}`,
    `Receipt / work order photo: ${report.photo ? "Attached in Fleetwise (not included in this text file)" : "No photo attached"}`,
    "",
    "Description:",
    report.description || "No description recorded.",
  ].join("\r\n");
  const safeName = String(vehicle.plate || vehicle.name || "vehicle").replace(/[^a-z0-9_-]+/gi, "-");
  const safeDate = String(report.date || new Date().toISOString().slice(0, 10)).replace(/[^0-9-]/g, "");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = `Fleetwise-maintenance-${safeName}-${safeDate}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}
// Card accent colors for the Stations tab, cycled per station.
const STATION_TILE_COLORS = ["#e5262f", "#f0b90b", "#2d3a52", "#627eea", "#8247e5", "#14b8a6", "#f97316", "#0ea5e9"];
// Copy a station's login username so an admin can share it.
function copyStationLogin(index) {
  if (role !== "admin") return;
  const name = state.stations[index];
  if (!name) return;
  const text = stationLoginName(name);
  const done = () => toast(`Copied login name: ${text}`);
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => toast("Copy failed. Login name: " + text));
  else toast("Copy not supported here. Login name: " + text);
}
// Admins get an organization-wide station report; station accounts see only their feedback.
function renderStationReports() {
  const names = [...new Set([...state.stations, ...state.vehicles.map((v) => v.station || "Unassigned")])];
  renderStationManager();
  const selector = document.getElementById("feedbackStation");
  if (selector) selector.innerHTML = role === "admin" ? names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("") : "";
  const reportSelector = document.getElementById("reportTargetStation");
  if (reportSelector) reportSelector.innerHTML = role === "admin" ? names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("") : "";
  const reportList = document.getElementById("stationReportList");
  if (reportList) reportList.innerHTML = role !== "admin" ? "" : names.map((name, detailIndex) => {
    const units = state.vehicles.filter((v) => (v.station || "Unassigned") === name);
    const ids = new Set(units.map((v) => v.id));
    const reports = state.repairs.filter((r) => ids.has(r.vehicleId)).sort((a, b) => b.date.localeCompare(a.date));
    const spend = reports.reduce((sum, r) => sum + Number(r.cost || 0), 0);
    const odometerStats = units.map((vehicle) => odometerDistance(vehicle.id));
    const distanceStats = odometerStats.filter((stats) => stats.readingCount > 1);
    const distanceSummary = distanceStats.length
      ? formatDistance(distanceStats.reduce((sum, stats) => sum + stats.traveled, 0))
      : "Not recorded";
    const hasActiveVehicle = units.some((vehicle) => vehicle.status !== "Disposed");
    const unreadReportCount = reports.filter((report) => report.submittedByRole === "station" && !report.adminReadAt).length;
    const unreadMessageCount = state.feedback.filter((message) => message.station === name && !message.readAt).length;
    const stationIndex = state.stations.indexOf(name);
    const latestRequest = state.reportRequests
      .filter((request) => request.station === name)
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
    const requestStatus = latestRequest?.status === "pending"
      ? `<span class="request-state pending">Report requested · ${new Date(latestRequest.requestedAt).toLocaleDateString("en-PH")}</span>`
      : latestRequest?.status === "complete"
        ? `<span class="request-state complete">Last request completed · ${new Date(latestRequest.completedAt).toLocaleDateString("en-PH")}</span>`
        : "";
    const requestButton = stationIndex >= 0
      ? latestRequest?.status === "pending"
        ? '<button class="btn secondary" disabled>Request pending</button>'
        : `<button class="btn secondary" onclick="requestStationReport(${stationIndex})" ${hasActiveVehicle ? "" : "disabled title=\"Assign an active vehicle before requesting a report\""}>Request report</button>`
      : "";
    const unreadStatus = unreadReportCount || unreadMessageCount
      ? `<small class="station-unread-indicator">${unreadReportCount} unread report(s) · ${unreadMessageCount} unread message(s)</small>`
      : "";
    const tint = STATION_TILE_COLORS[detailIndex % STATION_TILE_COLORS.length];
    const canDelete = stationIndex >= 0;
    const loginLabel = canDelete ? stationLoginName(name) : "";
    return `<article class="station-tile" style="--tile:${tint}" onclick="openStationTile(event, ${detailIndex})"><span class="station-tile-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5M8 9h.01M12 9h.01M16 9h.01M8 12h.01M12 12h.01M16 12h.01"/></svg></span><button type="button" class="station-tile-open" aria-label="Open ${esc(name)} details" onclick="openStationDetailsFromSummary(${detailIndex})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7M8 7h9v9"/></svg></button><div class="station-tile-body"><span class="station-tile-label">Station</span><button type="button" class="station-tile-name" onclick="openStationDetailsFromSummary(${detailIndex})">${esc(name)}</button><small class="station-tile-stats">${units.length} vehicle(s) · ${reports.length} report(s) · ${money(spend)}</small><small class="station-tile-stats">Distance: ${distanceSummary}</small>${unreadStatus}${requestStatus}</div><div class="station-tile-foot">${requestButton}<span class="station-tile-actions">${canDelete ? `<button type="button" class="station-tile-icon-btn danger" title="Delete ${esc(name)}" aria-label="Delete ${esc(name)}" onclick="deleteStation(${stationIndex})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button><button type="button" class="station-tile-icon-btn" title="Copy login name (${esc(loginLabel)})" aria-label="Copy login name for ${esc(name)}" onclick="copyStationLogin(${stationIndex})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button>` : ""}</span></div></article>`;
  }).join("");
  const feedbackList = document.getElementById("stationFeedbackList");
  if (feedbackList) {
    // Combine admin feedback and open report requests into one station notification feed.
    const notifications = [
      ...state.feedback
        .filter((item) => item.station === station)
        .map((item) => ({ ...item, kind: "feedback", createdAt: item.createdAt || item.date })),
      ...state.reportRequests
        .filter((item) => item.station === station && item.status === "pending")
        .map((item) => ({ ...item, kind: "request", createdAt: item.requestedAt, message: "Please submit a current maintenance report for one of your station vehicles." })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    feedbackList.innerHTML = notifications.length ? notifications.map((item) => {
      const stamp = new Date(item.createdAt).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
      const title = item.kind === "request" ? "Maintenance report requested" : "Message from Fleet Administrator";
      const action = item.kind === "request"
        ? `<button class="btn secondary" onclick="openRequestedReport('${escId(item.id)}')">Create report</button>`
        : "";
      return `<article class="notification-item ${item.readAt ? "" : "unread"}"><div class="notification-item-head"><b>${title}</b><small>${esc(stamp)}${item.readAt ? "" : " · New"}</small></div><p>${esc(item.message)}</p>${action}</article>`;
    }).join("") : '<div class="empty">No notifications from the administrator yet.</div>';
  }
  const reportBox = document.getElementById("generatedReports");
  if (reportBox) reportBox.innerHTML = state.generatedReports.slice().reverse().map((r, index) => { const reportIndex = state.generatedReports.length - index - 1; return `<article class="generated-report"><div><b>${esc(r.title)}</b><small>${esc(r.createdAt)}</small></div><pre>${esc(r.body)}</pre><div class="generated-report-actions"><button class="btn secondary" onclick="downloadReport(${reportIndex})">Download .txt</button><button class="btn danger" onclick="deleteGeneratedReport(${reportIndex})">Delete report</button></div></article>`; }).join("") || '<div class="muted-note">No reports generated yet.</div>';
}
// Open the station detail page from a station card in the report list.
function openStationTile(event, index) {
  // The card opens on ordinary clicks, while its own buttons keep their separate actions.
  if (event.target.closest("button")) return;
  openStationDetailsFromSummary(index);
}
function openStationDetailsFromSummary(index) {
  if (role !== "admin") return;
  const names = [...new Set([...state.stations, ...state.vehicles.map((vehicle) => vehicle.station || "Unassigned")])];
  openStationDetails(names[index]);
}
// Make station names in the manager list open their matching detail page.
function openStationReportDetails(stationIndex) {
  if (role !== "admin") return;
  openStationDetails(state.stations[stationIndex]);
}
// Switch the admin workspace to the selected station's own detail page.
function openStationDetails(name) {
  if (role !== "admin" || !name) return;
  selectedStationDetail = name;
  nav("stationDetail");
}
// Open a message addressed to the station on this page, like writing its name on an envelope.
function messageSelectedStation() {
  if (role !== "admin" || !state.stations.includes(selectedStationDetail)) return;
  // Remember the recipient now so changing pages cannot send this draft to another station.
  const recipient = selectedStationDetail;
  modal(
    "Message station",
    "Send an administrator message to this station.",
    `<form id="stationMessageForm" class="form"><div class="form-grid"><div class="field full"><label for="stationMessageRecipient">To</label><input id="stationMessageRecipient" value="${esc(recipient)}" readonly></div><div class="field full"><label for="stationMessageText">Message</label><textarea id="stationMessageText" rows="5" required placeholder="Write your message to this station…"></textarea></div></div><div class="form-actions"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button type="submit" class="btn primary">Send message</button></div></form>`,
  );
  const messageInput = document.getElementById("stationMessageText");
  messageInput.addEventListener("input", () => messageInput.setCustomValidity(""));
  document.getElementById("stationMessageForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (role !== "admin") return;
    if (!state.stations.includes(recipient)) return toast("This station is no longer available.");
    const message = messageInput.value.trim();
    if (!message) {
      messageInput.setCustomValidity("Write a message before sending.");
      messageInput.reportValidity();
      return;
    }
    // Use the same message box as station feedback, so notifications and unread marks work too.
    const createdAt = new Date().toISOString();
    state.feedback.push({ id: crypto.randomUUID(), station: recipient, message, date: createdAt.slice(0, 10), createdAt, readAt: null, adminSeenAt: null });
    save();
    closeModal();
    toast(`Message sent to ${recipient}.`);
  });
  messageInput.focus();
}
// Render only the selected station's fleet and repair history in its separate page.
function renderSelectedStationDetails() {
  const title = document.getElementById("stationDetailsTitle");
  const summary = document.getElementById("stationDetailsSummary");
  const vehicleList = document.getElementById("stationDetailsVehicles");
  const repairList = document.getElementById("stationDetailsRepairs");
  const repairVehicleFilter = document.getElementById("stationDetailsRepairVehicleFilter");
  const messageList = document.getElementById("stationDetailsMessages");
  const requestAction = document.getElementById("stationDetailsRequestAction");
  if (!title || !summary || !vehicleList || !repairList || !repairVehicleFilter || !messageList || !requestAction) return;
  if (role !== "admin" || !selectedStationDetail) {
    title.textContent = "Station details";
    summary.textContent = "Select a station to view details.";
    vehicleList.innerHTML = "";
    repairList.innerHTML = "";
    repairVehicleFilter.innerHTML = '<option value="">All station vehicles</option>';
    messageList.innerHTML = "";
    requestAction.innerHTML = "";
    return;
  }
  const units = state.vehicles.filter((vehicle) => (vehicle.station || "Unassigned") === selectedStationDetail);
  const vehicleIds = new Set(units.map((vehicle) => vehicle.id));
  const reports = state.repairs
    .filter((report) => vehicleIds.has(report.vehicleId) || (report.submittedByRole === "station" && report.submittedByStation === selectedStationDetail))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const previousVehicleFilter = repairVehicleFilter.value;
  repairVehicleFilter.innerHTML = '<option value="">All station vehicles</option>' + units.map((vehicle) => {
    const label = `${vehicle.plate || vehicle.name || "No plate"}${vehicle.model ? ` · ${vehicle.model}` : ""}`;
    return `<option value="${esc(vehicle.id)}">${esc(label)}</option>`;
  }).join("");
  if (units.some((vehicle) => vehicle.id === previousVehicleFilter)) repairVehicleFilter.value = previousVehicleFilter;
  const selectedRepairVehicle = repairVehicleFilter.value;
  const visibleReports = reports.filter((report) => !selectedRepairVehicle || report.vehicleId === selectedRepairVehicle);
  const unreadReports = reports.filter((report) => report.submittedByRole === "station" && !report.adminReadAt).length;
  const messages = state.feedback
    .filter((message) => message.station === selectedStationDetail)
    .sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")));
  const unreadMessages = messages.filter((message) => !message.readAt).length;
  const distanceStats = units.map((vehicle) => odometerDistance(vehicle.id)).filter((stats) => stats.readingCount > 1);
  const stationDistance = distanceStats.length
    ? formatDistance(distanceStats.reduce((sum, stats) => sum + stats.traveled, 0))
    : "Not recorded";
  const spend = reports.reduce((sum, report) => sum + Number(report.cost || 0), 0);
  title.textContent = selectedStationDetail;
  summary.textContent = `${units.length} vehicle(s) · ${reports.length} repair report(s) · ${money(spend)} total repairs · Distance between odometer readings: ${stationDistance} · ${unreadReports} unread report(s) · ${unreadMessages} unread message(s)`;
  vehicleList.innerHTML = units.length ? units.map((vehicle) => {
    const stats = odometerDistance(vehicle.id);
    const latest = stats.latest === null ? "Not recorded" : formatDistance(stats.latest);
    const traveled = stats.readingCount > 1
      ? formatDistance(stats.traveled)
      : stats.readingCount === 1 ? "Needs another reading" : "Not recorded";
    return `<article class="station-detail-vehicle">
      <div class="station-detail-vehicle-top"><span class="station-detail-vehicle-icon" aria-hidden="true">${vehicle.type === "Motorcycle" ? "🏍️" : "🚙"}</span><span class="tag ${vehicle.status === "Disposed" ? "neutral" : vehicle.status === "Maintenance" ? "warn" : "good"}">${esc(vehicle.status || "Active")}</span></div>
      <div class="station-detail-vehicle-heading"><b>${esc(vehicle.name || vehicle.plate || "Vehicle")}</b><small>${esc(vehicle.plate || "No plate")} · ${esc(vehicle.make || "")} ${esc(vehicle.model || "")}</small></div>
      <div class="station-detail-facts"><span><small>Type</small><b>${esc(vehicle.type || "Vehicle")}</b></span><span><small>Acquired</small><b>${vehicle.acquired ? esc(new Date(vehicle.acquired + "T00:00:00").toLocaleDateString("en-PH", { month: "short", year: "numeric" })) : "—"}</b></span><span><small>Useful life</small><b>${esc(vehicle.usefulLife || "—")} ${vehicle.usefulLife ? "years" : ""}</b></span><span><small>Repairs this year</small><b>${money(yrSpend(vehicle.id))}</b></span><span><small>Latest odometer</small><b>${esc(latest)}</b></span><span><small>Distance between readings</small><b>${esc(traveled)}</b></span></div>
    </article>`;
  }).join("") : '<div class="empty">No vehicles are assigned to this station.</div>';
  messageList.innerHTML = messages.length ? messages.map((message) => {
    const status = message.readAt
      ? '<span class="tag good">Read by station</span>'
      : '<span class="tag warn">Unread by station</span>';
    return `<article class="station-detail-message"><div><b>Administrator message</b><small>${esc(message.createdAt || message.date || "Date not recorded")}</small></div>${status}<p>${esc(message.message)}</p></article>`;
  }).join("") : '<div class="empty">No administrator messages for this station.</div>';
  repairList.innerHTML = visibleReports.length ? visibleReports.map((report) => {
    const vehicle = state.vehicles.find((item) => item.id === report.vehicleId);
    const unreadMark = report.submittedByRole === "station" && !report.adminReadAt
      ? '<span class="tag warn">Unread</span>'
      : report.submittedByRole === "station"
        ? '<span class="tag good">Read</span>'
        : "";
    return `<article class="station-detail-report"><div><b>${esc(vehicle?.plate || vehicle?.name || "Vehicle")} · ${esc(report.category || "Repair")}</b><small>${esc(report.date || "Date not recorded")} · ${esc(report.description || "No description")}</small>${unreadMark}</div><div class="station-detail-report-value"><b>${money(report.cost)}</b><small>${esc(report.odometer || "—")} km · ${esc(report.days || 0)} day(s) out</small><button type="button" class="btn secondary" onclick="showStationReportDetails('${escId(report.id)}')">View details</button></div></article>`;
  }).join("") : selectedRepairVehicle
    ? '<div class="empty">No repair reports are recorded for this vehicle.</div>'
    : '<div class="empty">No repair reports have been submitted for this station.</div>';
  const stationIndex = state.stations.indexOf(selectedStationDetail);
  const hasActiveVehicle = units.some((vehicle) => vehicle.status !== "Disposed");
  const pendingRequest = state.reportRequests.some((request) => request.station === selectedStationDetail && request.status === "pending");
  const requestButton = pendingRequest
    ? '<button class="btn secondary" disabled>Request pending</button>'
    : `<button class="btn secondary" onclick="requestStationReport(${stationIndex})" ${hasActiveVehicle ? "" : "disabled title=\"Assign an active vehicle before requesting a report\""}>Request report</button>`;
  requestAction.innerHTML = stationIndex < 0 ? "" : `${requestButton}<button type="button" class="btn primary" onclick="messageSelectedStation()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.5Z"/></svg>Message station</button>`;
}
// Show new reports and admin messages that their station has not read yet.
function renderAdminNotifications() {
  const list = document.getElementById("adminNotificationsList");
  if (!list) return;
  if (role !== "admin") { list.innerHTML = ""; return; }
  const reports = state.repairs
    .filter((report) => report.submittedByRole === "station" && !report.adminReadAt)
    .map((report) => {
      const vehicle = state.vehicles.find((item) => item.id === report.vehicleId);
      return {
        type: "report",
        id: report.id,
        station: report.submittedByStation || vehicle?.station || "Unknown station",
        createdAt: report.createdAt || report.date,
        title: "New maintenance report",
        detail: `${vehicle?.plate || vehicle?.name || "Vehicle"} · ${report.category || "Maintenance"} · ${money(report.cost)}`,
        message: report.description || "A station submitted a maintenance report.",
      };
    });
  const messages = state.feedback
    .filter((message) => !message.readAt && !message.adminSeenAt)
    .map((message) => ({
      type: "message",
      id: message.id,
      station: message.station,
      createdAt: message.createdAt || message.date,
      title: "Message not yet read by station",
      detail: "Administrator feedback",
      message: message.message,
    }));
  const notifications = [...reports, ...messages]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  list.innerHTML = notifications.length ? notifications.map((item) => {
    const time = item.createdAt
      ? new Date(item.createdAt).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })
      : "Date not recorded";
    const statusLabel = item.type === "report" ? "Unread report" : "Unread by station";
    return `<article class="admin-notification-item"><div class="admin-notification-head"><div><b>${esc(item.title)}</b><small>${esc(item.station)} · ${esc(time)}</small></div><span class="tag warn">${statusLabel}</span></div><div class="admin-notification-detail"><b>${esc(item.detail)}</b><p>${esc(item.message)}</p></div><button type="button" class="btn secondary" onclick="openAdminNotification('${item.type}','${escId(item.id)}')">Open ${esc(item.station)}</button></article>`;
  }).join("") : '<div class="empty">No new station reports or unread messages.</div>';
}
// Mark a report as reviewed, or mark a message as seen by the admin, then open its station page.
function openAdminNotification(type, itemId) {
  if (role !== "admin") return;
  let stationName = "";
  if (type === "report") {
    const report = state.repairs.find((item) => item.id === itemId && item.submittedByRole === "station");
    const vehicle = report && state.vehicles.find((item) => item.id === report.vehicleId);
    if (!report || !vehicle) return toast("This station report is no longer available.");
    stationName = report.submittedByStation || vehicle.station || "Unassigned";
    report.adminReadAt = new Date().toISOString();
  } else if (type === "message") {
    const message = state.feedback.find((item) => item.id === itemId);
    if (!message) return toast("This station message is no longer available.");
    stationName = message.station;
    message.adminSeenAt = new Date().toISOString();
  } else {
    return;
  }
  selectedStationDetail = stationName;
  save();
  nav("stationDetail");
}
// Create one open report request for a station; its station can see it in Create report.
function requestStationReport(index) {
  if (role !== "admin") return;
  const name = state.stations[index];
  if (!name) return;
  if (!state.vehicles.some((vehicle) => vehicle.station === name && vehicle.status !== "Disposed")) {
    return toast("Assign an active vehicle to this station before requesting a report.");
  }
  const existing = state.reportRequests.find((request) => request.station === name && request.status === "pending");
  if (existing) return toast(`A report is already requested from ${name}.`);
  state.reportRequests.push({
    id: crypto.randomUUID(),
    station: name,
    requestedAt: new Date().toISOString(),
    status: "pending",
  });
  save();
  toast(`Report requested from ${name}.`);
}
// Mark station messages and open report requests read when the notification page opens.
function markStationNotificationsRead() {
  if (role !== "station") return;
  const readAt = new Date().toISOString();
  let changed = false;
  state.feedback.forEach((item) => {
    if (item.station === station && !item.readAt) { item.readAt = readAt; changed = true; }
  });
  state.reportRequests.forEach((item) => {
    if (item.station === station && item.status === "pending" && !item.readAt) { item.readAt = readAt; changed = true; }
  });
  if (changed) localStorage.setItem(KEY, JSON.stringify(state));
}
// Show unread admin messages to stations and new station activity to administrators.
function updateNotificationBell(adminAlertCount) {
  const button = document.getElementById("alertsBtn");
  const ping = document.getElementById("notificationPing");
  if (!button || !ping) return;
  const unreadStationCount = role === "station"
    ? state.feedback.filter((item) => item.station === station && !item.readAt).length +
      state.reportRequests.filter((item) => item.station === station && item.status === "pending" && !item.readAt).length
    : 0;
  const unreadAdminReports = state.repairs.filter((report) => report.submittedByRole === "station" && !report.adminReadAt).length;
  const unreadAdminMessages = state.feedback.filter((message) => !message.readAt && !message.adminSeenAt).length;
  const count = role === "station"
    ? unreadStationCount
    : role === "admin"
      ? unreadAdminReports + unreadAdminMessages
      : adminAlertCount;
  ping.classList.toggle("hidden", count === 0);
  button.title = role === "station" ? `Admin notifications${count ? ` (${count} new)` : ""}` : `Notifications${count ? ` (${count} new)` : ""}`;
  button.setAttribute("aria-label", button.title);
}
// Jump from a report-request notification to the station's report form and request details.
function openRequestedReport(requestId) {
  if (role !== "station") return;
  const request = state.reportRequests.find((item) => item.id === requestId && item.station === station && item.status === "pending");
  if (!request) return toast("This report request is no longer pending.");
  nav("report");
}
// Open a maintenance form from the station's pending request notice.
function startReportForRequest(requestId) {
  if (role !== "station") return;
  const request = state.reportRequests.find((item) => item.id === requestId && item.station === station && item.status === "pending");
  const vehicleId = document.getElementById("reportCarSelect")?.value;
  if (!request) return toast("This report request is no longer pending.");
  if (!vehicleId) return toast("Your station has no vehicle available for a report.");
  addRepair(vehicleId);
}
// Render admin station controls and show the default demo login for each station.
function renderStationManager() {
  const list = document.getElementById("stationManagerList");
  if (!list) return;
  if (role !== "admin") { list.innerHTML = ""; return; }
  list.innerHTML = state.stations.map((name, index) => `<div class="station-manager-row"><button type="button" class="station-manager-name" onclick="openStationReportDetails(${index})"><b>${esc(name)}</b><small>Click to view vehicles and reports · Login: <code>${esc(stationLoginName(name))}</code></small></button><button class="btn danger" onclick="deleteStation(${index})">Delete</button></div>`).join("") || '<div class="muted-note">No stations added yet.</div>';
}
function deleteStation(index) {
  if (role !== "admin") return;
  const name = state.stations[index];
  if (!name) return;
  if (!window.confirm(`Delete ${name}? Its vehicles will be retained as Unassigned, and its feedback and report requests will be removed.`)) return;
  state.vehicles.forEach((v) => { if (v.station === name) v.station = "Unassigned"; });
  state.feedback = state.feedback.filter((f) => f.station !== name);
  state.reportRequests = state.reportRequests.filter((request) => request.station !== name);
  state.stations = state.stations.filter((s) => s !== name);
  save(); toast("Station deleted. Its vehicles remain in the fleet as Unassigned.");
}
// Build a reviewable report draft from saved monthly repair and fleet records.
function generateReport(kind) {
  if (role !== "admin") return;
  const month = document.getElementById("reportMonth").value || new Date().toISOString().slice(0, 7);
  const target = document.getElementById("reportTargetStation").value;
  const stations = kind === "station" ? [target] : [...new Set(state.vehicles.map((v) => v.station || "Unassigned"))];
  const lines = [`${kind === "station" ? "Station Fleet Summary" : "Monthly Fleet Report"} — ${month}`, "Generated from fleet records. Review and validate before official use.", ""];
  for (const name of stations) {
    const units = state.vehicles.filter((v) => (v.station || "Unassigned") === name);
    const ids = new Set(units.map((v) => v.id));
    const repairs = state.repairs.filter((r) => ids.has(r.vehicleId) && String(r.date || "").startsWith(month));
    const spend = repairs.reduce((n, r) => n + Number(r.cost || 0), 0);
    const downtime = repairs.reduce((n, r) => n + Number(r.days || 0), 0);
    const high = units.filter(inWatch).length;
    lines.push(`${name}: ${units.length} assigned unit(s); ${repairs.length} repair report(s); ${money(spend)} repair spend; ${downtime} downtime day(s); ${high} unit(s) flagged for replacement review.`);
    const top = repairs.slice().sort((a,b) => Number(b.cost || 0) - Number(a.cost || 0))[0];
    if (top) lines.push(`Observation: highest single repair cost was ${money(top.cost)} for ${top.description || "a reported repair"}.`);
    if (high) lines.push(`Suggested follow-up: review the ${high} flagged unit(s) for maintenance history, condition, and replacement planning.`);
    if (!repairs.length) lines.push("Observation: no repair reports were recorded for this period.");
    lines.push("");
  }
  const title = kind === "station" ? `${target} station summary · ${month}` : `Monthly fleet report · ${month}`;
  state.generatedReports.push({ title, body: lines.join("\n"), createdAt: new Date().toLocaleString() });
  save(); toast("Report draft generated.");
}
function downloadReport(index) {
  const r = state.generatedReports[index]; if (!r) return;
  const blob = new Blob([r.body], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = r.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".txt"; a.click(); URL.revokeObjectURL(url);
}
// Remove only the selected saved report after a confirmation click.
function deleteGeneratedReport(index) {
  if (role !== "admin" || !state.generatedReports[index]) return;
  const title = state.generatedReports[index].title;
  if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
  state.generatedReports.splice(index, 1);
  save();
  toast("Generated report deleted.");
}
function toast(msg) {
  let r = document.getElementById("toastRoot");
  r.innerHTML = '<div class="toast">' + esc(msg) + "</div>";
  setTimeout(() => (r.innerHTML = ""), 2800);
}
function modal(title, sub, body) {
  document.getElementById("modalRoot").innerHTML =
    `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><section class="modal"><div class="modal-head"><div><h2>${title}</h2><p>${sub}</p></div><button class="close" onclick="closeModal()">×</button></div>${body}</section></div>`;
}
function closeModal() {
  document.getElementById("modalRoot").innerHTML = "";
}
function addVehicle() {
  if (role !== "admin")
    return toast("Administrator access is required to add assets.");
  modal(
    "Add fleet asset",
    "Register a new procurement or donation.",
    `<form id="assetForm" class="form"><div class="form-note">Include the acquisition source and useful life so the system can build an auditable profile and replacement outlook.</div><div class="form-grid"><div class="field"><label>Asset type *</label><select name="type" required><option>Vehicle</option><option>Motorcycle</option></select></div><div class="field"><label>Acquisition type *</label><select name="acquisition" required><option>Procurement</option><option>Donation</option><option>Transfer</option></select></div><div class="field"><label>Asset name *</label><input name="name" required placeholder="e.g. Patrol Unit 01"></div><div class="field"><label>Plate / asset no.</label><input name="plate" placeholder="ABC 1234"></div><div class="field"><label>Make *</label><input name="make" required placeholder="Toyota"></div><div class="field"><label>Model *</label><input name="model" required placeholder="Hilux"></div><div class="field"><label>Station / office *</label><select name="station" required>${stationOptions("", true)}</select></div><div class="field"><label>Date acquired *</label><input name="acquired" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div><div class="field"><label>Useful life (years) *</label><input name="usefulLife" type="number" min="1" required placeholder="10"></div><div class="field"><label>Replacement cost estimate (₱)</label><input name="replacementCost" type="number" min="0" placeholder="2500000"></div><div class="field full"><label>Acquisition notes / funding source</label><textarea name="notes" placeholder="Funding source, donor, procurement reference…"></textarea></div></div><div class="form-actions"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn primary">Save asset</button></div></form>`,
  );
  document.getElementById("assetForm").onsubmit = (e) => {
    e.preventDefault();
    let d = Object.fromEntries(new FormData(e.target));
    d.id = crypto.randomUUID();
    d.status = "Active";
    d.createdAt = new Date().toISOString();
    state.vehicles.push(d);
    save();
    closeModal();
    toast("Asset added to the fleet register.");
  };
}
function addRepair(id) {
  window.repairPhotoData = null;
  let v = state.vehicles.find((x) => x.id === id);
  if (!v) return;
  if (role === "station" && String(v.station || "").toLowerCase() !== String(station || "").toLowerCase()) return toast("You can only log repairs for your station's vehicles.");
  modal(
    "Create maintenance report",
    "Add a service event to " +
      esc(v.name || v.plate || v.make + " " + v.model) +
      ".",
    `<form id="repairForm" class="form"><div class="form-note">Take a clear photo of the receipt or work order. OCR reads it in this browser and fills likely fields; review and correct everything before saving.</div><div class="form-grid"><div class="field full"><label>Receipt / work order photo</label><div class="photo-actions"><button type="button" id="takeRepairPhoto" class="btn primary">📷 Take a photo</button><button type="button" id="chooseRepairPhoto" class="btn secondary">Choose an image</button></div><input id="repairPhoto" type="file" accept="image/*" capture="environment" hidden><input id="repairPhotoFile" type="file" accept="image/*" hidden><small id="photoStatus" class="muted-note">Take a photo or choose an image to auto-fill the form.</small></div><div class="field"><label>Car</label><input value="${esc(v.plate || v.make + " " + v.model)}" readonly></div><div class="field"><label>Date *</label><input name="date" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div><div class="field"><label>Odometer (km)</label><input name="odometer" type="number" min="0" placeholder="000000"></div><div class="field"><label>Category *</label><select name="category" required><option>Brakes</option><option>Engine</option><option>Tires</option><option>Electrical</option><option>Preventive maintenance</option><option>Body / exterior</option><option>Other</option></select></div><div class="field"><label>Cost (₱) *</label><input name="cost" type="number" min="0" required placeholder="0.00"></div><div class="field"><label>Funding source</label><select name="funding"><option>Organization</option><option>LGU</option><option>Donor</option><option>Other</option></select></div><div class="field"><label>Days out of service</label><input name="days" type="number" min="0" placeholder="0"></div><div class="field full"><label>Description *</label><textarea name="description" required placeholder="What was repaired?"></textarea></div><div class="field full"><label>Service provider / reference</label><input name="provider" placeholder="Workshop, work order, invoice reference"></div></div><div class="form-actions"><button type="button" class="btn secondary" onclick="closeModal()">Cancel</button><button class="btn primary">Save maintenance report</button></div></form>`,
  );
  const cameraInput = document.getElementById("repairPhoto");
  const imageInput = document.getElementById("repairPhotoFile");
  document.getElementById("takeRepairPhoto").onclick = () => cameraInput.click();
  document.getElementById("chooseRepairPhoto").onclick = () => imageInput.click();
  [cameraInput, imageInput].forEach((input) => input.addEventListener("change", async (event) => {
    const file = event.target.files[0]; if (!file) return;
    const status = document.getElementById("photoStatus");
    const image = await compressReceiptImage(file);
    const readFile = () => new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(image); });
    window.repairPhotoData = await readFile();
    if (!window.Tesseract) { status.textContent = "Photo attached. OCR couldn't load; check your internet connection, then try again."; return; }
    status.textContent = "Reading the photo… the first scan can take a little while.";
    try {
      if (!window.repairOcrWorker) window.repairOcrWorker = await Tesseract.createWorker("eng", 1, { logger: (m) => { if (m.status === "recognizing text" && document.getElementById("photoStatus")) status.textContent = `Reading photo… ${Math.round((m.progress || 0) * 100)}%`; } });
      const { data } = await window.repairOcrWorker.recognize(image);
      const text = (data.text || "").replace(/\r/g, "\n").trim();
      if (!text) { status.textContent = "No readable text found. Try a clearer photo or fill the fields manually."; return; }
      autofillRepairFromText(text);
      status.textContent = "Photo read. Check the highlighted values and correct anything OCR got wrong.";
    } catch (error) {
      console.error("Receipt OCR failed", error);
      status.textContent = "Could not read the photo. Check internet access and try again, or fill the form manually.";
    }
  }));
  document.getElementById("repairForm").onsubmit = (e) => {
    e.preventDefault();
    let d = Object.fromEntries(new FormData(e.target));
    d.id = crypto.randomUUID();
    d.vehicleId = id;
    d.photo = window.repairPhotoData || null;
    window.repairPhotoData = null;
    d.createdAt = new Date().toISOString();
    d.submittedByRole = role;
    if (role === "station") {
      // These fields let the admin bell flag and track this new station submission.
      d.submittedByStation = station;
      d.adminReadAt = null;
    } else d.adminReadAt = d.createdAt;
    state.repairs.push(d);
    // The next station report fulfills its oldest open administrator request.
    if (role === "station") {
      const openRequest = state.reportRequests
        .filter((request) => request.station === station && request.status === "pending")
        .sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)))[0];
      if (openRequest) {
        openRequest.status = "complete";
        openRequest.completedAt = new Date().toISOString();
        openRequest.reportId = d.id;
      }
    }
    save();
    closeModal();
    toast("Maintenance report saved.");
    showDetail(id);
  };
}
// Turn OCR output into likely repair values. Every autofilled field remains editable.
function autofillRepairFromText(text) {
  const form = document.getElementById("repairForm");
  const fill = (name, value) => { const field = form.querySelector(`[name="${name}"]`); if (field && value) { field.value = value; field.classList.add("ocr-filled"); } };
  const isoDate = (() => {
    let m = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
    m = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/);
    if (!m) return "";
    let a=Number(m[1]), b=Number(m[2]), month=a>12?b:a, day=a>12?a:b;
    if (b>12) { month=a; day=b; }
    return `${m[3]}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  })();
  fill("date", isoDate);
  const odo = text.match(/(?:odometer|mileage|\bodo\b)\D{0,15}([\d,]{4,})\s*(?:km)?/i);
  if (odo) fill("odometer", odo[1].replace(/,/g,""));
  const costMatch = text.match(/(?:grand\s+total|amount\s+due|total\s+amount|total)\D{0,24}(?:PHP|₱|P)?\s*([\d,]+(?:\.\d{2})?)/i) || text.match(/(?:PHP|₱)\s*([\d,]+(?:\.\d{2})?)/i);
  if (costMatch) fill("cost", costMatch[1].replace(/,/g,""));
  const category = /brake|pad|rotor/i.test(text) ? "Brakes" : /engine|spark|coolant/i.test(text) ? "Engine" : /tire|tyre|wheel/i.test(text) ? "Tires" : /battery|electrical|alternator|wiring/i.test(text) ? "Electrical" : /oil|preventive|periodic|scheduled maintenance/i.test(text) ? "Preventive maintenance" : /body|paint|bumper/i.test(text) ? "Body / exterior" : "";
  if (category) fill("category", category);
  const lines = text.split(/\n+/).map((line)=>line.trim()).filter((line)=>line.length>4 && /repair|replace|service|maintenance|brake|engine|oil|tire|battery|labor|change/i.test(line) && !/total|vat|invoice|receipt|thank you/i.test(line));
  const description = lines.slice(0,3).join("; ") || text.replace(/\s+/g," ").slice(0,350);
  fill("description", description);
}
// Downsize phone photos so localStorage can keep the attachment with its report.
async function compressReceiptImage(file) {
  if (!window.createImageBitmap || !document.createElement("canvas").toBlob) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1500 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), "image/jpeg", 0.72));
  } catch { return file; }
}
function showDetail(id) {
  let v = state.vehicles.find((x) => x.id === id);
  if (!v) return;
  let rr = state.repairs
    .filter((r) => r.vehicleId === id)
    .sort((a, b) => b.date.localeCompare(a.date));
  modal(
    esc(v.name || v.make + " " + v.model),
    `${esc(v.plate || "No plate")} · ${esc(v.type)} · ${esc(v.station || "No station assigned")}`,
    `<div class="form"><div class="detail-cards"><div class="detail-card"><small>Acquisition</small><b>${esc(v.acquisition || "—")}</b></div><div class="detail-card"><small>Useful life</small><b>${v.usefulLife || "—"} years</b></div><div class="detail-card"><small>Repairs this year</small><b>${money(yrSpend(id))}</b></div></div><div style="font-size:11px;color:var(--muted);margin-bottom:15px">Acquired ${v.acquired || "date not set"} · Estimated replacement ${v.replacementCost ? money(v.replacementCost) : "not set"} · ${esc(v.notes || "No acquisition notes")}</div><div class="history"><h3>Repair history (${rr.length})</h3>${rr.length ? rr.map((r) => `<div class="history-item"><div><b>${esc(r.category || "Repair")}: ${esc(r.description)}</b><small>${esc(r.date)} · ${esc(r.odometer || "—")} km · ${esc(r.funding || "Funding not recorded")} · ${esc(r.days || 0)} days out</small></div><b>${money(r.cost)}</b></div>`).join("") : '<div class="empty" style="padding:15px">No repair entries yet.</div>'}</div><div class="form-actions" style="justify-content:space-between"><button class="btn secondary" onclick="addRepair('${escId(id)}')">＋ Create maintenance report</button><div style="display:flex;gap:8px"><button class="btn secondary admin-only" onclick="editAsset('${escId(id)}')">Edit profile</button><button class="btn danger admin-only" onclick="deleteAsset('${escId(id)}')">Delete asset</button>${v.status !== "Disposed" ? `<button class="btn danger admin-only" onclick="disposeAsset('${escId(id)}')">Record disposal</button>` : ""}</div></div></div>`,
  );
  applyRole();
}
function editAsset(id) {
  if (role !== "admin")
    return toast("Administrator access is required to edit asset profiles.");
  let v = state.vehicles.find((x) => x.id === id);
  if (!v) return;
  modal(
    "Edit asset profile",
    "Update vehicle details and useful life assumptions.",
    `<form id="editForm" class="form"><div class="form-grid"><div class="field"><label>Asset name</label><input name="name" value="${esc(v.name)}" required></div><div class="field"><label>Plate / asset no.</label><input name="plate" value="${esc(v.plate || "")}"></div><div class="field"><label>Station / office</label><select name="station">${stationOptions(v.station)}</select></div><div class="field"><label>Status</label><select name="status"><option ${v.status === "Active" ? "selected" : ""}>Active</option><option ${v.status === "Maintenance" ? "selected" : ""}>Maintenance</option><option ${v.status === "Disposed" ? "selected" : ""}>Disposed</option></select></div><div class="field"><label>Useful life (years)</label><input name="usefulLife" type="number" min="1" value="${esc(v.usefulLife)}"></div><div class="field"><label>Replacement estimate (₱)</label><input name="replacementCost" type="number" min="0" value="${esc(v.replacementCost || "")}"></div></div><div class="form-actions"><button type="button" class="btn secondary" onclick="showDetail('${escId(id)}')">Cancel</button><button class="btn primary">Save changes</button></div></form>`,
  );
  document.getElementById("editForm").onsubmit = (e) => {
    e.preventDefault();
    Object.assign(v, Object.fromEntries(new FormData(e.target)));
    save();
    closeModal();
    toast("Asset profile updated.");
  };
}
function disposeAsset(id) {
  let v = state.vehicles.find((x) => x.id === id);
  if (!v || role !== "admin") return;
  modal(
    "Record asset disposal",
    "This moves the asset out of active inventory and keeps its full history.",
    `<form id="disposeForm" class="form"><div class="form-grid"><div class="field"><label>Turn-in / disposal date *</label><input name="disposedDate" type="date" required value="${new Date().toISOString().slice(0, 10)}"></div><div class="field"><label>Disposition type *</label><select name="disposition"><option>Turned in for disposal</option><option>Transferred</option><option>Sold</option><option>Written off</option></select></div><div class="field full"><label>Reference / notes</label><textarea name="disposalNotes" placeholder="Approval reference, condition, receiving office…"></textarea></div></div><div class="form-actions"><button type="button" class="btn secondary" onclick="showDetail('${escId(id)}')">Cancel</button><button class="btn danger">Record disposal</button></div></form>`,
  );
  document.getElementById("disposeForm").onsubmit = (e) => {
    e.preventDefault();
    Object.assign(v, Object.fromEntries(new FormData(e.target)));
    v.status = "Disposed";
    save();
    closeModal();
    toast("Disposal recorded. Asset history retained.");
  };
}
// Permanently remove a mistaken asset entry and its attached repair records.
function deleteAsset(id) {
  if (role !== "admin") return toast("Only an administrator can delete a fleet asset.");
  const vehicle = state.vehicles.find((v) => v.id === id);
  if (!vehicle) return;
  if (!window.confirm(`Delete ${vehicle.plate || vehicle.name || "this asset"}, its repair reports, maintenance schedules, and forecast history? This cannot be undone.`)) return;
  state.vehicles = state.vehicles.filter((v) => v.id !== id);
  state.repairs = state.repairs.filter((r) => r.vehicleId !== id);
  state.maintenanceSchedules = state.maintenanceSchedules.filter((schedule) => schedule.vehicleId !== id);
  state.maintenanceScheduleHistory = state.maintenanceScheduleHistory.filter((entry) => entry.vehicleId !== id);
  state.maintenancePredictions = state.maintenancePredictions.filter((prediction) => prediction.vehicleId !== id);
  save();
  closeModal();
  toast("Asset and its repair records deleted.");
}
function applyRole() {
  document
    .querySelectorAll(".admin-only")
    .forEach((x) => x.classList.toggle("hidden", role !== "admin"));
  document
    .querySelectorAll(".station-only")
    .forEach((x) => x.classList.toggle("hidden", role !== "station"));
  ["dashboard", "planning"].forEach((name) => document.querySelector(`[data-nav="${name}"]`).classList.toggle("hidden", role === "station"));
  document.querySelector(".metric-grid").classList.toggle("hidden", role === "station");
  document.querySelector(".overview").classList.toggle("hidden", role === "station");
  document.getElementById("profileRole").textContent =
    role === "admin" ? "Administrator" : "Station staff";
  document.getElementById("profileName").textContent =
    role === "admin" ? "Fleet Administrator" : station || "Station Staff";
  document.getElementById("profileAvatar").textContent = role === "admin" ? "AD" : "ST";
  document.getElementById("fleetNavLabel").textContent = role === "station" ? "My vehicles" : "Fleet inventory";
  // TEA totals are organization-wide, so keep them in the administrator view.
  document.querySelector(".overview .panel").classList.toggle("hidden", role !== "admin");
}
function nav(name) {
  currentNav = name;
  if (role === "station" && name === "feedback") markStationNotificationsRead();
  let titles = {
    dashboard: [
      "Fleet overview",
      "A clear view of your fleet's readiness, costs, and replacement needs.",
    ],
    vehicles: [
      "Fleet inventory",
      "Register acquisitions and donations, and keep each asset profile up to date.",
    ],
    report: ["Create report", "Submit a repair or maintenance report for one of your station vehicles."],
    reportHistory: ["Report history", "Review all maintenance reports submitted by your station."],
    repairs: [
      "Repairs & maintenance",
      "Review repair history, upcoming service, and completed maintenance.",
    ],
    planning: [
      "Replacement planning & maintenance insights",
      "Review early maintenance warnings alongside replacement needs.",
    ],
    stations: ["Stations & reports", "Review each station's vehicles and repair reports."],
    stationDetail: [selectedStationDetail || "Station details", "View this station's assigned vehicles and complete repair history."],
    adminNotifications: ["Notifications", "Review reports submitted by stations and messages still unread by their stations."],
    feedback: ["Notifications", "Review report requests and messages from fleet administration."],
  };
  let t = titles[name] || titles.dashboard;
  if (role === "station" && name === "vehicles") t[0] = "My vehicles";
  document.getElementById("pageTitle").textContent = t[0];
  document.getElementById("crumbPage").textContent = t[0];
  document.getElementById("pageDesc").textContent = t[1];
  document
    .querySelectorAll(".nav-item[data-nav]")
    .forEach((n) => n.classList.toggle("active", n.dataset.nav === name));
  document.getElementById("tableTitle").textContent =
    name === "repairs"
      ? "Repair and maintenance history"
      : name === "planning"
        ? "Replacement planning watchlist"
        : "Fleet inventory";
  const stationCars = role === "station" && name === "vehicles";
  const special = name === "stations" || name === "stationDetail" || name === "adminNotifications" || name === "feedback" || name === "report" || name === "reportHistory";
  document.getElementById("inventorySection").classList.toggle("hidden", special || stationCars);
  document.getElementById("stationCarsPanel").classList.toggle("hidden", !stationCars);
  document.getElementById("stationCreatePanel").classList.toggle("hidden", name !== "report" || role !== "station");
  document.getElementById("stationHistoryPanel").classList.toggle("hidden", name !== "reportHistory" || role !== "station");
  document.getElementById("maintenanceSchedulePanel").classList.toggle("hidden", name !== "repairs");
  document.getElementById("stationsPanel").classList.toggle("hidden", name !== "stations" || role !== "admin");
  document.getElementById("predictiveMaintenancePanel").classList.toggle("hidden", name !== "planning" || role !== "admin");
  document.getElementById("stationDetailsPanel").classList.toggle("hidden", name !== "stationDetail" || role !== "admin");
  document.getElementById("adminNotificationsPanel").classList.toggle("hidden", name !== "adminNotifications" || role !== "admin");
  document.getElementById("feedbackPanel").classList.toggle("hidden", name !== "feedback" || role !== "station");
  // Dashboard metrics and fleet overview belong only on the dashboard tab.
  const isAdminDashboard = role === "admin" && name === "dashboard";
  document.querySelector(".metric-grid").classList.toggle("hidden", !isAdminDashboard);
  document.querySelector(".overview").classList.toggle("hidden", !isAdminDashboard);
  // Keep the quick asset action on the dashboard and fleet inventory pages only.
  const canAddVehicleHere = role === "admin" && (name === "dashboard" || name === "vehicles");
  document.getElementById("addVehicleBtn").classList.toggle("hidden", !canAddVehicleHere);
  document.querySelector(".heading").classList.toggle("hidden", role === "station" && name === "feedback");
  const sectionId = name === "repairs" ? "maintenanceSchedulePanel" : name === "planning" ? "predictiveMaintenancePanel" : name === "stations" ? "stationsPanel" : name === "stationDetail" ? "stationDetailsPanel" : name === "adminNotifications" ? "adminNotificationsPanel" : name === "feedback" ? "feedbackPanel" : name === "report" ? "stationCreatePanel" : name === "reportHistory" ? "stationHistoryPanel" : stationCars ? "stationCarsPanel" : "inventorySection";
  document.getElementById(sectionId).scrollIntoView({ behavior: "smooth", block: "start" });
  render();
}
document
  .querySelectorAll("[data-nav]")
  .forEach((b) => b.addEventListener("click", () => nav(b.dataset.nav)));
document.getElementById("addVehicleBtn").onclick = addVehicle;
document.getElementById("searchInput").oninput = render;
document.getElementById("stationCarSearch").oninput = renderStationCars;
document.getElementById("startMaintenanceReport").onclick = () => {
  const id = document.getElementById("reportCarSelect").value;
  if (id) addRepair(id); else toast("No cars are assigned to your station yet.");
};
document.querySelectorAll("[data-car-filter]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-car-filter]").forEach((b) => b.classList.toggle("active", b === button));
  renderStationCars();
}));
document.getElementById("typeFilter").onchange = render;
document.getElementById("statusFilter").onchange = render;
document.getElementById("repairPeriodFilter").onchange = render;
document.getElementById("maintenanceScheduleForm").addEventListener("submit", saveMaintenanceSchedule);
document.getElementById("scheduleStation").addEventListener("change", () => updateMaintenanceScheduleVehicleOptions());
document.getElementById("maintenanceScheduleStationFilter").addEventListener("change", () => {
  updateMaintenanceScheduleVehicleFilterOptions(document.getElementById("maintenanceScheduleVehicleFilter").value);
  renderMaintenanceSchedule();
});
document.getElementById("maintenanceScheduleVehicleFilter").addEventListener("change", renderMaintenanceSchedule);
document.getElementById("stationDetailsRepairVehicleFilter").addEventListener("change", renderSelectedStationDetails);
document.getElementById("scheduleIntervalType").addEventListener("change", updateScheduleIntervalFields);
document.getElementById("cancelScheduleEdit").addEventListener("click", cancelMaintenanceScheduleEdit);
document.querySelectorAll("[data-schedule-filter]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-schedule-filter]").forEach((item) => item.classList.toggle("active", item === button));
  renderMaintenanceSchedule();
}));
updateScheduleIntervalFields();
document.getElementById("alertsBtn").onclick = () => nav(role === "station" ? "feedback" : "adminNotifications");
// The profile button opens account actions; outside clicks and Escape close them.
document.getElementById("profileMenuToggle").addEventListener("click", (event) => {
  event.stopPropagation();
  const panel = document.getElementById("profileMenuPanel");
  setProfileMenuOpen(panel.hidden);
});
document.addEventListener("click", (event) => {
  if (!event.target.closest("#profileMenu")) setProfileMenuOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.getElementById("profileMenuPanel").hidden) {
    setProfileMenuOpen(false);
    document.getElementById("profileMenuToggle").focus();
  }
});
document.getElementById("settingsBtn").onclick = () => {
  setProfileMenuOpen(false);
  // Everyone can choose colors. Fleet warning information stays with the administrator.
  const fleetSettings = role === "admin" ? `<section class="settings-thresholds"><h3>Replacement warnings</h3><div class="form-note">These default warning thresholds are applied to the records stored in this browser.</div><div class="detail-cards"><div class="detail-card"><small>Repair spend warning</small><b>75% of new cost</b></div><div class="detail-card"><small>High risk</small><b>100% of new cost</b></div><div class="detail-card"><small>Life warning</small><b>1 year remaining</b></div></div><p class="settings-note">For shared use, secure authentication, role permissions, and synchronized storage must be provided by a backend deployment.</p></section>` : "";
  modal(
    "Settings",
    "Make your Fleetwise workspace comfortable to use.",
    `<div class="form"><section class="appearance-settings" aria-labelledby="appearanceTitle"><h3 id="appearanceTitle">Appearance</h3><p>Choose the colors for your workspace and login page.</p><div class="field"><label for="appearanceTheme">Color mode</label><select id="appearanceTheme" aria-describedby="appearanceStatus"><option value="light">Light mode</option><option value="dark">Dark mode</option></select></div><p id="appearanceStatus" class="appearance-status" role="status">Changes apply immediately and are remembered in this browser.</p></section>${fleetSettings}<div class="form-actions"><button class="btn primary" onclick="closeModal()">Done</button></div></div>`,
  );
  const themeSelector = document.getElementById("appearanceTheme");
  themeSelector.value = window.FleetwiseTheme.get();
  themeSelector.addEventListener("change", () => {
    const saved = window.FleetwiseTheme.set(themeSelector.value);
    document.getElementById("appearanceStatus").textContent = saved
      ? `${themeSelector.value === "dark" ? "Dark" : "Light"} mode saved for this browser.`
      : "Mode changed for this visit. Your browser could not save the preference.";
  });
};
document.getElementById("feedbackForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (role !== "admin") return;
  const message = document.getElementById("feedbackMessage").value.trim();
  if (!message) return;
  state.feedback.push({ id: crypto.randomUUID(), station: document.getElementById("feedbackStation").value, message, date: new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString(), readAt: null, adminSeenAt: null });
  document.getElementById("feedbackMessage").value = "";
  save();
  toast("Feedback sent to station.");
});
document.getElementById("stationForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (role !== "admin") return;
  const name = document.getElementById("newStationName").value.trim();
  if (!name) return;
  if (state.stations.some((s) => s.toLowerCase() === name.toLowerCase())) return toast("That station already exists.");
  if (state.stations.some((s) => stationLoginName(s) === stationLoginName(name))) return toast("This name would create a duplicate station login username.");
  state.stations.push(name);
  document.getElementById("newStationName").value = "";
  save();
  toast(`Station added. Station login username: ${stationLoginName(name)}; password: station123.`);
});
document.getElementById("reportMonth").value = new Date().toISOString().slice(0, 7);
document.getElementById("makeMonthlyReport").addEventListener("click", () => generateReport("monthly"));
document.getElementById("makeStationReport").addEventListener("click", () => generateReport("station"));
applyRole();
render();
