import time
from firebase_client import get, post
from Brain import think

AGENT_ID = "mobile"
POLL_INTERVAL = 3  # seconds

def listen_for_commands():
    """
    Polls Firebase for mobile-specific commands and broadcast commands for all agents
    """
    while True:
        try:
            # Mobile-specific commands
            command_data = get(f"agents/mobile/{AGENT_ID}/command")
            if command_data:
                handle_command(command_data)
                post(f"agents/mobile/{AGENT_ID}/status", {
                    "lastExecuted": command_data,
                    "timestamp": time.time(),
                    "success": True
                })

            # Broadcast commands for all agents
            broadcast_data = get("agents/all/command")
            if broadcast_data:
                handle_command(broadcast_data)
                post(f"agents/mobile/{AGENT_ID}/status", {
                    "lastExecuted": broadcast_data,
                    "timestamp": time.time(),
                    "success": True
                })

        except Exception as e:
            print(f"[Agent Sync Error] {e}")

        time.sleep(POLL_INTERVAL)

def handle_command(command):
    """
    Execute commands by sending them to Brain and printing/logging output
    """
    print(f"[Mobile Agent] Received command: {command}")
    result = think(command)
    print(f"[Mobile Agent] Result: {result}")
