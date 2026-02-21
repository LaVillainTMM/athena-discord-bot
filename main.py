from agent import listen_for_commands

def start():
    print("[Athena Mobile] Online and syncing with all agents...")
    listen_for_commands()

if __name__ == "__main__":
    start()
