// Bring in Express so this file can answer requests from the Fleetwise website.
const express = require("express");

// Borrow the PostgreSQL health checker from our database helper file.
const { checkDatabaseConnection } = require("./db");

// Make the web server that will hold our API routes.
const app = express();

// Let the server read JSON sent by the website in a request.
app.use(express.json({ limit: "1mb" }));

// Give us a simple route to check whether the backend is awake.
app.get("/api/health", (request, response) => {
  response.json({
    status: "ok",
    message: "Fleetwise backend is running",
  });
});

// Check both the server and PostgreSQL connection without revealing private details.
app.get("/api/health/database", async (request, response) => {
  try {
    const databaseTime = await checkDatabaseConnection();
    response.json({
      status: "ok",
      database: "connected",
      databaseTime,
    });
  } catch (error) {
    // Keep the technical error in the server console, not in the public response.
    console.error("PostgreSQL health check failed:", error.message);
    response.status(503).json({
      status: "error",
      database: "disconnected",
      message: "Check that PostgreSQL is running and backend/.env is correct.",
    });
  }
});

// Use the PORT setting if one is provided; otherwise use port 3000 on this computer.
const port = Number(process.env.PORT) || 3000;

// Start the server and print its address so it is easy to find.
app.listen(port, () => {
  console.log(`Fleetwise backend is running at http://localhost:${port}`);
});
