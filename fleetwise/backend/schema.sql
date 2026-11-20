-- Fleetwise PostgreSQL schema
-- Kid version: this file is the blueprint for the database's filing cabinets and folders.
-- Apply it to a new test database first. Never experiment directly on a live client database.
-- How to read this file: CREATE TABLE makes a new filing cabinet; each column is a labeled space;
-- a row is one saved thing, such as one vehicle. The words after -- explain the nearby SQL in plain language.
-- PRIMARY KEY is the row's unique name tag. REFERENCES points to a related row. NOT NULL means "must be filled in."
-- CHECK is a safety rule that rejects impossible values. INDEX is like a book index that helps find things faster.

-- Turns on PostgreSQL's UUID generator, which makes hard-to-guess ID labels for records.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- These named lists keep important choices consistent instead of letting people type anything.
-- An enum is a dropdown with a fixed list of answers, so everyone uses the same words.
CREATE TYPE fleet_user_role AS ENUM ('admin', 'station'); -- Admin sees their whole client; station sees only its station.
CREATE TYPE fleet_asset_type AS ENUM ('vehicle', 'motorcycle'); -- The two kinds of fleet item this design tracks.
CREATE TYPE fleet_asset_status AS ENUM ('active', 'maintenance', 'disposed'); -- Working, being repaired, or retired.
CREATE TYPE fleet_acquisition_type AS ENUM ('procurement', 'donation', 'transfer'); -- Bought, donated, or moved from somewhere else.
CREATE TYPE maintenance_interval_type AS ENUM ('date', 'odometer'); -- Service is due by calendar or distance.
CREATE TYPE maintenance_schedule_status AS ENUM ('active', 'paused', 'completed', 'cancelled'); -- Whether a service rule is running.
CREATE TYPE forecast_method AS ENUM ('rules', 'ml'); -- A clear checklist or a trained machine-learning model.
CREATE TYPE forecast_outcome AS ENUM ('issue_found', 'no_issue_found', 'inspection_deferred', 'not_inspected'); -- What staff found after checking.
CREATE TYPE notification_type AS ENUM ('repair_report', 'admin_feedback', 'report_request', 'schedule_due', 'schedule_overdue'); -- Why an inbox note appeared.

-- ORGANIZATIONS: one box for each client company or agency using Fleetwise.
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this client.
  name text NOT NULL, -- The client name people see on screen.
  organization_code text NOT NULL UNIQUE, -- Short login code that tells us which client is signing in.
  created_at timestamptz NOT NULL DEFAULT now(), -- When this client was added.
  UNIQUE (name) -- Stops the same client name being entered twice.
);

-- STATIONS: each client's offices or stations live in this list.
CREATE TABLE stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this station.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns it.
  name text NOT NULL, -- Station name shown to users.
  station_code text NOT NULL, -- Short station code used by the system.
  is_active boolean NOT NULL DEFAULT true, -- False means the station is closed to sign-in but its history stays.
  created_at timestamptz NOT NULL DEFAULT now(), -- When this station was added.
  UNIQUE (organization_id, station_code), -- A client cannot use the same code twice.
  UNIQUE (organization_id, name), -- A client cannot add the same station name twice.
  UNIQUE (id, organization_id) -- Lets other tables prove the station belongs to the same client.
);

-- APP_USERS: login accounts for administrators and station staff.
CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this account.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client this account belongs to.
  station_id uuid, -- Station account's home station; admins leave this blank.
  username text NOT NULL, -- Name typed into the login form.
  display_name text NOT NULL, -- Friendly name shown in the app.
  password_hash text NOT NULL, -- Scrambled password proof; never save the real password here.
  role fleet_user_role NOT NULL, -- Says whether this person is an admin or station user.
  is_active boolean NOT NULL DEFAULT true, -- Turn off access without erasing the account's history.
  created_at timestamptz NOT NULL DEFAULT now(), -- When the account was created.
  updated_at timestamptz NOT NULL DEFAULT now(), -- When the account was last changed.
  FOREIGN KEY (station_id, organization_id) REFERENCES stations(id, organization_id), -- The station must belong to this same client.
  UNIQUE (id, organization_id), -- Helps other tables keep account records in the right client.
  CHECK ((role = 'station' AND station_id IS NOT NULL) OR (role = 'admin' AND station_id IS NULL)) -- Station users need a station; admins work across the client.
);
-- Makes login lookup quick and treats uppercase/lowercase usernames as the same.
CREATE UNIQUE INDEX app_users_username_per_org ON app_users (organization_id, lower(username));

-- USER_SESSIONS: remembers which browser has successfully signed in.
-- The browser keeps a secret cookie; this table keeps only its scrambled copy.
CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this login session.
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, -- Which account signed in.
  token_hash text NOT NULL UNIQUE, -- Scrambled cookie value used to recognize this browser.
  created_at timestamptz NOT NULL DEFAULT now(), -- When the sign-in began.
  expires_at timestamptz NOT NULL, -- When the user must sign in again.
  revoked_at timestamptz, -- Filled in when the user signs out or access is cancelled.
  last_seen_at timestamptz -- Most recent time this browser used the session.
);
-- Helps the server quickly find a user's sessions and expired logins.
CREATE INDEX user_sessions_user_expiry_idx ON user_sessions (user_id, expires_at);

-- VEHICLES: the client's fleet register, including motorcycles.
CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this asset.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns the asset.
  station_id uuid, -- Station currently responsible for the asset; blank means unassigned.
  asset_type fleet_asset_type NOT NULL DEFAULT 'vehicle', -- Car/vehicle or motorcycle.
  acquisition_type fleet_acquisition_type NOT NULL, -- How the client got it: purchase, donation, or transfer.
  name text NOT NULL, -- Friendly fleet name, such as Patrol Unit 01.
  plate_number text, -- License plate or asset number, if it has one.
  make text NOT NULL, -- Manufacturer name, such as Toyota.
  model text NOT NULL, -- Model name, such as Hilux.
  acquired_on date NOT NULL, -- Date the client received the asset.
  useful_life_years numeric(5,2) NOT NULL CHECK (useful_life_years > 0), -- Expected working life in years.
  replacement_cost numeric(14,2) CHECK (replacement_cost IS NULL OR replacement_cost >= 0), -- Estimated price of a replacement.
  status fleet_asset_status NOT NULL DEFAULT 'active', -- Active, being repaired, or disposed.
  acquisition_source text, -- Donor, budget, or other source of the asset.
  acquisition_notes text, -- Extra notes about how it was received.
  disposed_at timestamptz, -- When it was retired; its old reports stay saved.
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who first entered it.
  created_at timestamptz NOT NULL DEFAULT now(), -- When the row was first saved.
  updated_at timestamptz NOT NULL DEFAULT now(), -- When the row was last edited.
  FOREIGN KEY (station_id, organization_id) REFERENCES stations(id, organization_id), -- Assigned station must belong to this client.
  UNIQUE (id, organization_id), -- Helps keep related records in the same client.
  CHECK ((status = 'disposed' AND disposed_at IS NOT NULL) OR status <> 'disposed') -- A disposed asset needs a retirement date.
);
-- These indexes are shortcuts so common fleet searches load faster.
CREATE INDEX vehicles_org_station_status_idx ON vehicles (organization_id, station_id, status);
CREATE INDEX vehicles_org_type_idx ON vehicles (organization_id, asset_type);
-- Stops two active assets for one client from using the same plate number.
CREATE UNIQUE INDEX vehicles_active_plate_per_org_idx
  ON vehicles (organization_id, lower(plate_number))
  WHERE plate_number IS NOT NULL AND status <> 'disposed';

-- REPAIR_REPORTS: one station's saved story about a vehicle repair.
CREATE TABLE repair_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this report.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns this record.
  station_id uuid NOT NULL, -- Station that submitted the report.
  vehicle_id uuid NOT NULL, -- Vehicle or motorcycle that was repaired.
  report_date date NOT NULL, -- Day the repair happened.
  odometer_km bigint CHECK (odometer_km IS NULL OR odometer_km >= 0), -- Vehicle distance reading at the time.
  category text NOT NULL, -- What kind of work it was, such as brakes or tires.
  description text NOT NULL, -- Plain-language explanation of the work.
  repair_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (repair_cost >= 0), -- How much the repair cost.
  funding_source text, -- Who or what paid for the work.
  days_out_of_service integer NOT NULL DEFAULT 0 CHECK (days_out_of_service >= 0), -- Days the vehicle could not be used.
  service_provider text, -- Workshop or mechanic that did the work.
  reference_number text, -- Invoice, work-order, or receipt number.
  receipt_object_key text, -- Private file-store address for an optional receipt photo.
  submitted_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Station user who sent the report.
  submitted_at timestamptz NOT NULL DEFAULT now(), -- When the report reached the server.
  admin_read_at timestamptz, -- Time the admin first opened/read it; blank means unread.
  admin_read_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who read it.
  admin_feedback text, -- Admin's note about this specific repair report.
  reviewed_at timestamptz, -- When the admin finished reviewing it.
  deleted_at timestamptz, -- Keep the row but hide it if an admin removes a mistaken report.
  deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who hid the mistaken report.
  FOREIGN KEY (station_id, organization_id) REFERENCES stations(id, organization_id), -- Station must belong to this client.
  FOREIGN KEY (vehicle_id, organization_id) REFERENCES vehicles(id, organization_id), -- Vehicle must belong to this client.
  UNIQUE (id, organization_id) -- Lets another table point to this report safely.
);
-- Shortcuts for finding one vehicle's reports or a station's reports by date.
CREATE INDEX repair_reports_vehicle_date_idx ON repair_reports (organization_id, vehicle_id, report_date DESC);
CREATE INDEX repair_reports_station_date_idx ON repair_reports (organization_id, station_id, report_date DESC);
-- Shortcut for showing only reports the admin has not opened yet.
CREATE INDEX repair_reports_unread_idx ON repair_reports (organization_id, admin_read_at) WHERE admin_read_at IS NULL;

-- MAINTENANCE_TEMPLATES: reusable service rules approved by an admin.
-- Example: "Oil service every X km" for a particular vehicle type and model.
CREATE TABLE maintenance_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this template.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns the rule.
  name text NOT NULL, -- What the service is called, like Oil change.
  asset_type fleet_asset_type NOT NULL, -- Whether this rule is for vehicles or motorcycles.
  make text, -- Optional manufacturer filter; blank means any make.
  model text, -- Optional model filter; blank means any model of that make.
  interval_type maintenance_interval_type NOT NULL, -- Is the service due by calendar date or odometer?
  interval_days integer, -- Number of days between services when using a date interval.
  interval_km bigint, -- Number of kilometers between services when using an odometer interval.
  source_reference text NOT NULL, -- Manual/page/reference that supports this service interval.
  is_active boolean NOT NULL DEFAULT true, -- False means stop using this template for new schedules.
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who wrote the template.
  approved_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who checked and approved it.
  approved_at timestamptz, -- When the approval happened.
  created_at timestamptz NOT NULL DEFAULT now(), -- When this template was first saved.
  updated_at timestamptz NOT NULL DEFAULT now(), -- When it was last changed.
  UNIQUE (id, organization_id), -- Helps schedules prove the template belongs to this client.
  CHECK (
    -- A date rule needs days, and an odometer rule needs kilometers.
    (interval_type = 'date' AND interval_days IS NOT NULL AND interval_days > 0 AND interval_km IS NULL) OR
    (interval_type = 'odometer' AND interval_km IS NOT NULL AND interval_km > 0 AND interval_days IS NULL)
  )
);

-- MAINTENANCE_SCHEDULES: a rule assigned to one real vehicle.
CREATE TABLE maintenance_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this schedule.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns the schedule.
  vehicle_id uuid NOT NULL, -- The one vehicle that must follow this schedule.
  template_id uuid, -- Optional approved rule used to create this schedule.
  service_name text NOT NULL, -- Service task the station should do.
  interval_type maintenance_interval_type NOT NULL, -- Whether the next service is measured by date or kilometers.
  interval_days integer, -- Days between services for date-based schedules.
  interval_km bigint, -- Kilometers between services for odometer-based schedules.
  next_due_date date, -- Next date to do the service; blank for kilometer-based schedules.
  next_due_odometer_km bigint, -- Odometer reading when service is due; blank for date-based schedules.
  status maintenance_schedule_status NOT NULL DEFAULT 'active', -- Active, paused, finished, or cancelled.
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who created the schedule.
  created_at timestamptz NOT NULL DEFAULT now(), -- When this schedule was first made.
  updated_at timestamptz NOT NULL DEFAULT now(), -- When it was last changed.
  FOREIGN KEY (vehicle_id, organization_id) REFERENCES vehicles(id, organization_id), -- Vehicle must belong to the same client.
  FOREIGN KEY (template_id, organization_id) REFERENCES maintenance_templates(id, organization_id), -- Template must belong to the same client.
  UNIQUE (id, organization_id), -- Lets completion reports point to this schedule safely.
  CHECK (
    -- This guard makes sure a date schedule has date fields, and an odometer schedule has kilometer fields.
    (interval_type = 'date' AND interval_days IS NOT NULL AND interval_days > 0 AND next_due_date IS NOT NULL AND interval_km IS NULL AND next_due_odometer_km IS NULL) OR
    (interval_type = 'odometer' AND interval_km IS NOT NULL AND interval_km > 0 AND next_due_odometer_km IS NOT NULL AND next_due_odometer_km >= 0 AND interval_days IS NULL AND next_due_date IS NULL)
  )
);
-- Shortcuts that make it faster to find a vehicle's schedules and due work.
CREATE INDEX maintenance_schedules_vehicle_status_idx ON maintenance_schedules (organization_id, vehicle_id, status);
CREATE INDEX maintenance_schedules_due_date_idx ON maintenance_schedules (organization_id, next_due_date) WHERE status = 'active' AND interval_type = 'date';
CREATE INDEX maintenance_schedules_due_odometer_idx ON maintenance_schedules (organization_id, next_due_odometer_km) WHERE status = 'active' AND interval_type = 'odometer';
-- Stops the same template being added to the same vehicle twice by mistake.
CREATE UNIQUE INDEX maintenance_schedules_vehicle_template_idx
  ON maintenance_schedules (vehicle_id, template_id)
  WHERE template_id IS NOT NULL AND status <> 'cancelled';

-- MAINTENANCE_COMPLETIONS: each time a station says a scheduled service is done.
-- This keeps the old completion even after the next due date moves forward.
CREATE TABLE maintenance_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this completion report.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns the report.
  schedule_id uuid NOT NULL, -- Which repeating schedule this completion belongs to.
  vehicle_id uuid NOT NULL, -- Vehicle that received service.
  station_id uuid NOT NULL, -- Station that submitted this completion.
  service_name_snapshot text NOT NULL, -- Copy of the service name as it was when completed.
  completed_date date NOT NULL, -- Day the service happened.
  completed_odometer_km bigint CHECK (completed_odometer_km IS NULL OR completed_odometer_km >= 0), -- Distance reading when work finished.
  notes text, -- What the station wants the admin to know.
  receipt_object_key text, -- Private file-store address for an optional receipt photo.
  submitted_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Station user who sent the report.
  submitted_at timestamptz NOT NULL DEFAULT now(), -- When the server received it.
  admin_read_at timestamptz, -- Blank means the admin has not opened it yet.
  admin_read_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who opened the report.
  FOREIGN KEY (schedule_id, organization_id) REFERENCES maintenance_schedules(id, organization_id), -- Schedule must be in this client.
  FOREIGN KEY (vehicle_id, organization_id) REFERENCES vehicles(id, organization_id), -- Vehicle must be in this client.
  FOREIGN KEY (station_id, organization_id) REFERENCES stations(id, organization_id), -- Station must be in this client.
  UNIQUE (id, organization_id) -- Lets other tables point to this report safely.
);
-- Shortcuts for showing a vehicle's history and counting admin-unread submissions.
CREATE INDEX maintenance_completions_vehicle_date_idx ON maintenance_completions (organization_id, vehicle_id, completed_date DESC);
CREATE INDEX maintenance_completions_unread_idx ON maintenance_completions (organization_id, admin_read_at) WHERE admin_read_at IS NULL;

-- REPORT_REQUESTS: admin requests asking a station to send a maintenance report.
CREATE TABLE report_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this request.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns it.
  station_id uuid NOT NULL, -- Station that needs to send the report.
  requested_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who made the request.
  requested_at timestamptz NOT NULL DEFAULT now(), -- When the request was sent.
  due_at timestamptz, -- Optional deadline for the station.
  fulfilled_at timestamptz, -- Filled in when the station answers the request.
  fulfilled_report_id uuid REFERENCES repair_reports(id) ON DELETE SET NULL, -- Report that answered this request.
  FOREIGN KEY (station_id, organization_id) REFERENCES stations(id, organization_id), -- Station must belong to the same client.
  CHECK ((fulfilled_at IS NULL AND fulfilled_report_id IS NULL) OR (fulfilled_at IS NOT NULL AND fulfilled_report_id IS NOT NULL)) -- Request is either waiting or linked to its answer.
);
-- Helps the app quickly find report requests that are still waiting.
CREATE INDEX report_requests_station_pending_idx ON report_requests (organization_id, station_id, requested_at) WHERE fulfilled_at IS NULL;

-- STATION_FEEDBACK: messages admins send to a station.
CREATE TABLE station_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for the message.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns it.
  station_id uuid NOT NULL, -- Station that should receive the message.
  sent_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who wrote it.
  message text NOT NULL, -- Message words shown to station staff.
  sent_at timestamptz NOT NULL DEFAULT now(), -- When it was sent.
  station_read_at timestamptz, -- Blank means station staff have not opened it.
  FOREIGN KEY (station_id, organization_id) REFERENCES stations(id, organization_id) -- Station must belong to this client.
);
-- Shortcut for showing unread messages for one station.
CREATE INDEX station_feedback_unread_idx ON station_feedback (organization_id, station_id, sent_at DESC) WHERE station_read_at IS NULL;

-- GENERATED_REPORTS: saved monthly or station-summary drafts made by the admin.
CREATE TABLE generated_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this saved draft.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns the draft.
  station_id uuid, -- Blank for the whole organization; filled in for one-station summaries.
  report_type text NOT NULL CHECK (report_type IN ('monthly', 'station_summary')), -- Which kind of report it is.
  period_start date NOT NULL, -- First day included in the report.
  period_end date NOT NULL, -- Last day included in the report.
  title text NOT NULL, -- Heading shown above the report.
  body text NOT NULL, -- Report text the admin can review/download.
  generated_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who created the draft.
  created_at timestamptz NOT NULL DEFAULT now(), -- When it was created.
  FOREIGN KEY (station_id, organization_id) REFERENCES stations(id, organization_id), -- Selected station must belong to this client.
  CHECK (period_end >= period_start), -- The report cannot end before it starts.
  CHECK ((report_type = 'monthly' AND station_id IS NULL) OR (report_type = 'station_summary' AND station_id IS NOT NULL)) -- A station summary must name its station.
);
-- Shortcut for listing a client's reports from newest period to oldest.
CREATE INDEX generated_reports_org_period_idx ON generated_reports (organization_id, period_start DESC);

-- MODEL_VERSIONS: label each version of a trained model so results can be compared later.
CREATE TABLE model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this model version.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns the model record.
  version_name text NOT NULL, -- Human-readable version, like fleet-model-1.
  method text NOT NULL, -- Name of the method or algorithm used.
  training_data_cutoff date, -- Latest day included when the model learned from data.
  evaluation_metrics jsonb NOT NULL DEFAULT '{}'::jsonb, -- Saved scorecard showing how the model performed.
  is_active boolean NOT NULL DEFAULT false, -- True means this is the version currently used for new forecasts.
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who registered the version.
  created_at timestamptz NOT NULL DEFAULT now(), -- When this version was saved.
  UNIQUE (organization_id, version_name), -- A client cannot reuse the same version name.
  UNIQUE (id, organization_id) -- Lets forecasts prove the model belongs to this client.
);

-- MAINTENANCE_FORECASTS: save what the system thought, then what the inspection found.
-- Keeping both answers lets the team check whether future forecasts improve.
CREATE TABLE maintenance_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this saved forecast.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns it.
  vehicle_id uuid NOT NULL, -- Vehicle being checked.
  model_version_id uuid, -- Which trained model made the forecast; blank for the rules pilot.
  method forecast_method NOT NULL DEFAULT 'rules', -- Says whether this came from rules or a trained model.
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100), -- Review score between zero and one hundred, not automatically a failure chance.
  risk_level text NOT NULL CHECK (risk_level IN ('routine', 'watch', 'high')), -- Easy-to-read group for the score.
  feature_snapshot jsonb NOT NULL, -- Copy of the vehicle facts used at forecast time.
  explanation jsonb NOT NULL DEFAULT '[]'::jsonb, -- Reasons the system showed to the admin.
  forecasted_at timestamptz NOT NULL DEFAULT now(), -- Exact time the forecast was made.
  forecasted_on date NOT NULL DEFAULT CURRENT_DATE, -- Calendar day used to block same-day duplicates.
  review_due_at timestamptz NOT NULL, -- When staff should check the forecast.
  outcome forecast_outcome, -- What the inspection found; blank means it has not been reviewed.
  outcome_at timestamptz, -- When the inspection result was entered.
  outcome_notes text, -- Extra details about the inspection result.
  outcome_repair_report_id uuid REFERENCES repair_reports(id) ON DELETE SET NULL, -- Repair report caused by the inspection, if any.
  reviewed_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who recorded the result.
  deleted_at timestamptz, -- Keep a trace if an admin hides a mistaken duplicate.
  deleted_by uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Admin who hid the mistaken forecast.
  FOREIGN KEY (vehicle_id, organization_id) REFERENCES vehicles(id, organization_id), -- Vehicle must belong to this client.
  FOREIGN KEY (model_version_id, organization_id) REFERENCES model_versions(id, organization_id), -- Model must belong to this client.
  CHECK ((outcome IS NULL AND outcome_at IS NULL) OR (outcome IS NOT NULL AND outcome_at IS NOT NULL)) -- A result and its date are saved together.
);
-- Shortcuts for latest forecasts, due reviews, and duplicate/open-forecast protection.
CREATE INDEX maintenance_forecasts_org_created_idx ON maintenance_forecasts (organization_id, forecasted_at DESC);
CREATE UNIQUE INDEX maintenance_forecasts_vehicle_day_idx ON maintenance_forecasts (vehicle_id, forecasted_on) WHERE deleted_at IS NULL;
CREATE INDEX maintenance_forecasts_open_review_idx ON maintenance_forecasts (organization_id, review_due_at) WHERE outcome IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX maintenance_forecasts_one_open_per_vehicle_idx ON maintenance_forecasts (vehicle_id) WHERE outcome IS NULL AND deleted_at IS NULL;

-- AUDIT_LOGS: a paper trail of important changes, like who edited or removed a record.
-- Never put passwords, login cookies, or receipt photo contents in this table.
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, -- Number that increases for each audit note.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client this change belongs to.
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL, -- Person who made the change, if still active.
  action text NOT NULL, -- What happened, such as vehicle_updated.
  entity_type text NOT NULL, -- Kind of thing changed, such as vehicle or repair_report.
  entity_id uuid, -- ID of the thing that changed.
  details jsonb NOT NULL DEFAULT '{}'::jsonb, -- Small safe details about the change.
  created_at timestamptz NOT NULL DEFAULT now() -- When the change happened.
);
-- Shortcut for finding the change history of one item.
CREATE INDEX audit_logs_org_entity_idx ON audit_logs (organization_id, entity_type, entity_id, created_at DESC);

-- NOTIFICATIONS: small inbox notes shown to a station or one user.
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- Unique name tag for this inbox note.
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, -- Which client owns it.
  station_id uuid, -- Station inbox that should receive it, if station-wide.
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE, -- Or one specific user inbox.
  notification_kind notification_type NOT NULL, -- Why the notification was created.
  title text NOT NULL, -- Short heading shown in the app.
  body text NOT NULL, -- Message shown in the app.
  related_entity_type text, -- Kind of linked record, such as a report.
  related_entity_id uuid, -- ID of the linked record.
  created_at timestamptz NOT NULL DEFAULT now(), -- When the note appeared.
  read_at timestamptz, -- Blank means it has not been opened.
  FOREIGN KEY (station_id, organization_id) REFERENCES stations(id, organization_id), -- Station must belong to this client.
  CHECK (station_id IS NOT NULL OR user_id IS NOT NULL) -- Every note needs at least one recipient.
);
-- Shortcuts for loading unread notes in a station or a person's inbox.
CREATE INDEX notifications_station_unread_idx ON notifications (organization_id, station_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_user_unread_idx ON notifications (organization_id, user_id, created_at DESC) WHERE read_at IS NULL;
