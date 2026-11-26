

import { admin, rtdb } from "../firebase.js";

export async function publishAthenaStatus(
  status = {}
) {
  try {
    await rtdb.ref("athena/system/status").update({
      ...status,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    console.log(
      "[Realtime Database] Athena status updated"
    );

    return true;

  } catch (error) {
    console.error(
      "[Realtime Database] Status update failed:",
      error.message
    );

    return false;
  }
}

export function startRealtimeStatus() {
  const publish = () => publishAthenaStatus({
    online: true,
    platform: "railway",
    discord: "connected",
    configuredModel:
      process.env.GEMINI_MODEL || "gemini-2.5-pro",
    backgroundTasks:
      process.env.ATHENA_BACKGROUND_TASKS === "true",
    uptimeSeconds: Math.floor(process.uptime())
  });

  void publish();

  const timer = setInterval(publish, 60000);

  timer.unref();

  return timer;
}
