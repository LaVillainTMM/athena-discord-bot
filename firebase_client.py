import requests
import json

FIREBASE_URL = "https://athenaai-memory-default-rtdb.firebaseio.com"

def send(path, data):
    url = f"{FIREBASE_URL}/{path}.json"
    return requests.post(url, json=data)
