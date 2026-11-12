# Fleetwise REST API design

Base path: `/api/v1`. JSON uses ISO 8601 timestamps and ISO `YYYY-MM-DD` dates. UUIDs are opaque IDs. The browser must never send a trusted `organization_id`, role, or station assignment; the API derives those from the authenticated user.

## Kid-friendly guide

Think of the website as a person at a front desk and the API as the locked door to the records room. The website asks the API to do something; the API checks who is asking, then reads or changes the database. A station user gets only that station's records, while an administrator can see their whole organization.

- **Endpoint** means one web address that does one job. For example, `GET /vehicles` asks to see vehicles.
- **GET** means “show me.” **POST** means “please add or do this.” **PATCH** means “change this part.” **DELETE** means “remove or hide this.”
- **Request body** is the little package of information sent with an add or change request.
- **Authentication** means proving who you are by signing in. **Authorization** means checking what that person is allowed to do.
- **Organization** means one client using Fleetwise. **Station scope** means a station account can only reach its own station's folder.
- **Transaction** means a group of database changes that all succeed together, or all get undone if something goes wrong.
- **Soft delete** means hide a mistaken record while keeping its history for accountability.
- **Idempotency key** is a request receipt. If someone taps “generate” twice, the receipt helps prevent making the same schedules twice.

## Access rules

These are the door rules for the records room: the server checks them on every request, even if a button is hidden in the web page.

| Operation | Administrator | Station user |
|---|---|---|
| Manage stations, users, fleet assets, service templates, and schedules | Own organization | No |
| View organization fleet, station reports, forecasts, and summaries | Own organization | No |
| View assets, repair reports, schedules, feedback, and notifications | Own organization | Assigned station only |
| Submit a repair or scheduled-service completion | No, unless explicitly granted by policy | Assigned station only |
| Mark station submissions as reviewed/read; send feedback or report requests | Own organization | No |
| Read admin feedback, fulfill report requests, or mark messages read | No | Assigned station only |

Return `401` for no valid session, `403` for a role/scope violation, `404` when a record is outside the caller's scope, `409` for duplicate or conflicting state, and `422` for invalid input. Use parameterized SQL and validate request bodies on the server.

## Authentication

These routes let someone sign in, sign out, check their own account, or change their password.

- `POST /auth/login` — accepts `{ "organizationCode": "client-code", "username": "...", "password": "..." }`; returns the signed-in user's safe profile and sets a secure session cookie.
- `POST /auth/logout` — revokes the current server session and clears the cookie.
- `GET /auth/me` — returns the current user, role, organization, and station assignment.
- `POST /auth/password` — changes the signed-in user's password after verifying the current password.

Login must be rate-limited. Passwords are stored as Argon2id hashes. Use CSRF protection for cookie-authenticated write requests and HTTPS in production. Avoid returning whether a username or password specifically was wrong.

## Stations and users (admin)

These routes let an administrator set up the station list and the people who can sign in.

- `GET /stations`
- `POST /stations` — create a station and optionally its first station user in one transaction.
- `PATCH /stations/:stationId` — rename or deactivate a station. Deactivation is safer than deleting a station with fleet history.
- `GET /users`
- `POST /users` — create an admin or assign a station user to one station.
- `PATCH /users/:userId` — change allowed profile fields, station assignment, or active status; never accept a role change from a station user.

## Fleet assets

These routes manage the vehicle and motorcycle register. Disposal retires an asset without erasing its old repair history.

- `GET /vehicles?stationId=&type=&status=&search=` — admins may filter their organization; station users are always scoped to their assigned station.
- `POST /vehicles` — admin creates a procurement, donation, or transfer record.
- `GET /vehicles/:vehicleId` — details only when within the caller's scope.
- `PATCH /vehicles/:vehicleId` — admin edits a profile or assignment.
- `POST /vehicles/:vehicleId/disposal` — admin marks an asset disposed and records the reason/date; preserve its history.

## Repair reports

These routes let a station send repair details and let an administrator review them. The server checks that the vehicle belongs to the station before accepting the report.

- `GET /repair-reports?stationId=&vehicleId=&from=&to=&unread=` — admin can filter the organization; station users see only their own station.
- `POST /repair-reports` — station submits date, vehicle, odometer, category, description, cost, funding source, downtime, and optional receipt object key. The server verifies that the vehicle belongs to the signed-in station.
- `GET /repair-reports/:reportId` — view details within role scope.
- `PATCH /repair-reports/:reportId/review` — admin records read/review state and feedback.
- `DELETE /repair-reports/:reportId` — admin correction path; implement as a soft delete and write an audit event.

Receipt images upload directly to a private object store using a short-lived signed URL. The API stores only the resulting object key. Do not store large base64 images in SQL rows.

## Preventive maintenance

These routes manage approved service rules and schedules. A preview is like checking a shopping list before pressing the button that saves everything.

- `GET /maintenance-templates` — admin's approved templates.
- `POST /maintenance-templates` and `PATCH /maintenance-templates/:templateId` — create/edit a template, including interval basis, vehicle applicability, and source reference.
- `POST /maintenance-templates/:templateId/approve` — second-person or authorized admin approval for the interval.
- `POST /maintenance-schedules/generation-preview` — admin supplies `{ "templateId": "...", "stationIds": ["..."], "startDate": "YYYY-MM-DD" }`; returns matching vehicles, proposed due points, existing schedules, and exceptions without writing records.
- `POST /maintenance-schedules/generate` — admin confirms a preview using an idempotency key. Create schedules in a transaction; skip/report existing template assignments.
- `GET /maintenance-schedules?stationId=&vehicleId=&status=` — admin can filter across the organization; station users are automatically restricted to their station.
- `POST /maintenance-schedules/:scheduleId/completions` — assigned station submits completion date, odometer, notes, and optional receipt. In one transaction, insert completion history, update the next due point, and create an admin notification.
- `PATCH /maintenance-completions/:completionId/read` — admin marks a submission reviewed; station users cannot change admin-read state.
- `PATCH /maintenance-schedules/:scheduleId` / `DELETE /maintenance-schedules/:scheduleId` — admin edits or cancels a schedule. Keep completion history.

If a vehicle has no valid latest odometer or service date, return it as a preview exception and ask an admin to set a starting due point. Never guess a due interval from an LLM response.

## Admin feedback, requests, and notifications

These routes send messages or report requests to a station and let the right person see and mark them as read.

- `POST /stations/:stationId/feedback` — admin sends feedback to a station.
- `POST /stations/:stationId/report-requests` — admin requests a report; return `409` if one is already pending.
- `GET /notifications` — returns notifications visible to the current user/station.
- `PATCH /notifications/:notificationId/read` — mark only the caller's notification read.
- `GET /events` — optional Server-Sent Events stream for new notifications; requires the same session and station scope as REST.

## Generated reports and forecasts

These routes save monthly summaries and maintenance warnings. A forecast is a review reminder based on evidence; it is not a promise that a vehicle will break.

- `POST /reports/monthly` — admin generates a saved report for a date range.
- `POST /reports/station-summary` — admin generates a saved station summary.
- `GET /reports` / `GET /reports/:reportId` / `DELETE /reports/:reportId` — list, inspect, or remove generated drafts within the organization.
- `POST /maintenance-forecasts` — admin records a rule-based or model forecast with an immutable `feature_snapshot`, explanation, review due date, and optional model version.
- `PATCH /maintenance-forecasts/:forecastId/outcome` — admin records the inspection outcome and notes, optionally linking the repair report.
- `GET /maintenance-forecasts?stationId=&vehicleId=&outcome=` — admin review list.

For machine learning, keep prediction snapshots and actual outcomes so the team can measure false alarms and missed issues. Version the training dataset and model; do not use the untrained browser rule score as an ML probability.

## Main screen data mapping

This map connects each page in the current website to the database records the backend would use.

| Existing Fleetwise view | API source |
|---|---|
| Dashboard and fleet inventory | `vehicles`, `repair_reports`, grouped server queries |
| Station details and notifications | `stations`, `vehicles`, `repair_reports`, `station_feedback`, `notifications` |
| Maintenance schedule | `maintenance_templates`, `maintenance_schedules`, `maintenance_completions` |
| Report history | `repair_reports` |
| Predictive maintenance | `maintenance_forecasts`, `model_versions`, repair and odometer history |

