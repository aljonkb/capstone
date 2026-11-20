// Load the private settings from backend/.env when the server starts.
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Bring in PostgreSQL's connection pool so requests can reuse database connections.
const { Pool } = require("pg");

// Check that the settings needed to sign in to PostgreSQL were provided.
const requiredSettings = ["DB_NAME", "DB_USER", "DB_PASSWORD"];
const missingSettings = requiredSettings.filter((setting) => !process.env[setting]);

// Stop with a helpful message instead of failing later with a confusing login error.
if (missingSettings.length > 0) {
  throw new Error(
    `Missing ${missingSettings.join(", ")} in backend/.env. Copy backend/.env.example to backend/.env and fill it in.`,
  );
}

// Make a small group of database connections the server can borrow as needed.
const pool = new Pool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

// Run a safe database query; pass values separately so user text is not treated as SQL code.
function query(text, values = []) {
  return pool.query(text, values);
}

// Ask PostgreSQL for its current time to confirm that the connection works.
async function checkDatabaseConnection() {
  const result = await query("SELECT NOW() AS database_time");
  return result.rows[0].database_time;
}

// Share these tools with the server routes that need the database.
module.exports = { pool, query, checkDatabaseConnection };
