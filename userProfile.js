const db = require("../firebase");

async function getOrCreateUser(discordId, displayName) {
  const ref = db.ref("athena_ai/users");
  const snapshot = await ref.once("value");

  let foundUserId = null;

  snapshot.forEach(child => {
    const data = child.val();
    if (data.identity?.linkedDiscordIds?.includes(discordId)) {
      foundUserId = child.key;
    }
  });

  if (foundUserId) return foundUserId;

  const newRef = ref.push();
  await newRef.set({
    identity: {
      displayName,
      linkedDiscordIds: [discordId],
      createdAt: Date.now()
    }
  });

  return newRef.key;
}

module.exports = { getOrCreateUser };
