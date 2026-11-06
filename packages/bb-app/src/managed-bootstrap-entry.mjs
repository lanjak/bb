import process from "node:process";

const role = process.argv[2];
let phase = "waiting";
const validRole = role === "server" || role === "host-daemon";
function revoke() {
  phase = "revoked";
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
if (!validRole || !process.connected || process.send === undefined) {
  revoke();
} else {
  process.on("disconnect", () => { phase = "revoked"; });
  process.on("message", (message) => {
    if (typeof message !== "object" || message === null || message.channel !== "bb-provisional-bootstrap" || message.role !== role) {
      revoke();
      return;
    }
    if (message.type === "revoke") {
      revoke();
      return;
    }
    if (message.type !== "associate" || phase !== "waiting") {
      revoke();
      return;
    }
    phase = "associated";
    process.send({ channel: "bb-provisional-bootstrap", type: "associated", role }, (error) => {
      if (error !== null || !process.connected) revoke();
    });
  });
  process.send({ channel: "bb-provisional-bootstrap", type: "ready", role }, (error) => {
    if (error !== null || !process.connected) revoke();
  });
}
