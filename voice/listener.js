export function startListening(connection) {

  const receiver = connection.receiver;

  receiver.speaking.on("start", userId => {
    console.log("🎤 User speaking:", userId);
  });
}
