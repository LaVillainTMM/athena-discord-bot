import time
from firebase_client import get, post

USER_ID = "mobile_user_placeholder"

def listen_for_commands():
    while True:
        command = get(f"agents/mobile/{USER_ID}/command")
        
        if command:
            handle_command(command)
            post(f"agents/mobile/{USER_ID}", {
                "lastExecuted": command,
                "timestamp": time.time()
            })
        
        time.sleep(3)

def handle_command(command):
    print("Received command:", command)
    # Execution logic will go here later
