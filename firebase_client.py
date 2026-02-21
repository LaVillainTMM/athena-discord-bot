import requests
import json
import time

FIREBASE_URL = "https://athenaai-memory-default-rtdb.firebaseio.com"

def post(path, data):
    url = f"{FIREBASE_URL}/{path}.json"
    try:
        r = requests.post(url, json=data, timeout=5)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[Firebase POST] Error: {e}")
        return None

def get(path):
    url = f"{FIREBASE_URL}/{path}.json"
    try:
        r = requests.get(url, timeout=5)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"[Firebase GET] Error: {e}")
        return None
