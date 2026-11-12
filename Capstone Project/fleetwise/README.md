# Fleetwise fleet management prototype

Open index.html in a modern browser. Keep index.html, styles.css, auth.js, and app.js in the same folder. No build step or server is required.

## Demo sign-in

- Administrator: username admin, password admin123
- Station accounts: central, station01, station02, station03, or station04; password station123. Select the matching station at sign-in. Usernames are case-insensitive.
- Use the “Fill admin demo” or “Fill Station 01 demo” buttons on the login screen to fill in a working demo account.

The administrator can view and manage the organization fleet. Station accounts can view records assigned to their station and log repairs for those units. Assign the station name on each asset profile using the same name as the sign-in option.

Administrators can use **Stations & reports** to review each station's assigned vehicles and repair reports, send feedback to a selected station, and generate monthly or station summary drafts. The admin notification bell lists new station-submitted maintenance reports and administrator messages the station has not read; opening a notification takes the admin to that station's detail page. Unread report and message counts appear on station details until the relevant report is opened or the station reads its message. Station accounts see their own vehicles, can log repairs, and have a **Notifications** view for administrator messages and report requests addressed to their station. Replacement planning, organization-wide totals, and other stations' records are hidden from station accounts.

Administrators can add or delete stations in **Stations & reports**. Click a station name or **View details** to open a dedicated station page with assigned vehicles and repair history. Distance between reports is estimated from successive odometer readings, and each vehicle shows its latest recorded odometer. Added stations become options for asset assignment, reports, feedback, and station login. The station login username is the station name in lowercase with spaces and punctuation removed; the demo password is station123. Deleting a station reassigns its vehicles to Unassigned and removes that station's feedback.

Administrators can select **Request report** on a station card. The request appears in the station's **Notifications** feed and **Create report** tab. The notification bell opens this feed for station users; opening it marks new admin messages and requests as read. Saving a report fulfills the oldest pending request for that station; the admin station card then shows when the request was completed.

The station menu separates **My vehicles**, **Create report**, and **Report history**. Vehicle cards show the last report date, days since that report, report count, total repair spend, and overdue/under-repair status. Create report starts a new maintenance report. Report history lists all reports submitted by that station, newest first; each report has a details view with its maintenance fields and any supported receipt photo. The form includes car, date, odometer, category, cost, description, and receipt photo. Photo text autofill depends on experimental browser OCR support; the attached photo and form can still be used without OCR.

## Included

- Blue and white responsive interface.
- Dashboard fleet counts now reflect only vehicles and motorcycles entered in the register; no fixed TEA baseline figures are shown.
- Asset registration for procurement, donations, and transfers.
- Per asset acquisition details, station, estimated replacement cost, and useful economic life.
- Repair entries with cost, funding source, and days out of service.
- Repair form has **Take a photo** and **Choose an image** actions. Tesseract.js OCR reads receipt/work-order images in the browser and attempts to prefill date, odometer, category, cost, and description. It loads the OCR library and English data from jsDelivr on first use, so internet access is required. Review OCR values before saving.
- Monthly and station report drafts are data-driven summaries generated locally from logged fleet and repair records. They are not connected to an AI model in this prototype.
- Alerts when a unit has one year or less of useful life, or repair costs reach 75% of the estimated replacement cost. Costs at or above replacement cost are high risk.
- Disposal records that remove an asset from active inventory while retaining its history.
- Fleet inventory shows the latest maintenance report date, category, and description for each vehicle.
- Administrator delete action for correcting mistaken asset entries; deleting an asset also removes its repair records after confirmation.
- Browser-local persistence using localStorage.

## Understanding the source

The source files are separated by purpose: index.html contains the page structure and form fields, styles.css controls colors and layout, auth.js handles sign-in, and app.js handles fleet records and dashboard updates. Comments mark the main sections and explain the key functions.

## Production deployment

This is a front-end prototype, not a production secure or shared real-time system. Demo credentials and role checks are in the page JavaScript and can be inspected or bypassed. Browser storage is local to a device/browser. Before organizational use, connect the interface to an authenticated backend with server enforced role permissions, a shared database, audit history, backups, and secure transport/storage. Station restrictions must be enforced by the server, and live updates must come from the shared backend.

## Backend and database design

The proposed PostgreSQL schema, REST API, tenant/station access rules, and implementation sequence are documented in the [`backend`](backend/README.md) folder. The schema is a design file only; it has not been applied to a database, and the current browser app still uses local storage and demo sign-in.
