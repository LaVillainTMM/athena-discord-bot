import time
from firebase_client import get, post

USER_ID = "mobile_user_placeholder"

def listen_for_commands():
    while True:
        try:
            command_data = get(f"agents/mobile/{USER_ID}/command")
            if command_data:
                handle_command(command_data)
                # Clear command or mark as executed
                post(f"agents/mobile/{USER_ID}/status", {
                    "lastExecuted": command_data,
                    "timestamp": time.time()
                })
        except Exception as e:
            print(f"Sync error: {e}")
        time.sleep(3)

def handle_command(command):
    print("Received command:", command)
    # Execution logic
