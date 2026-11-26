
import express from "express";

export function startAthenaAPI() {
  const app = express();

  app.disable("x-powered-by");

  app.use(express.json({
    limit: "32kb"
  }));

  // Public availability endpoint
  app.get("/health", (req, res) => {
    res.json({
      status: "online",
      system: "Athena AI",
      gateway: "operational",
      version: "1.0.0",
      timestamp: new Date().toISOString()
    });
  });

  // Reject undefined endpoints
  app.use((req, res) => {
    res.status(404).json({
      error: "Endpoint not found"
    });
  });

  const PORT = Number(process.env.PORT || 3000);

  const server = app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `[Athena API] Gateway online on port ${PORT}`
      );
    }
  );

  return server;
}

