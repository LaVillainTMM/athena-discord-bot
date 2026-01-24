import requests
import json

FIREBASE_URL = "https://athenaai-memory-default-rtdb.firebaseio.com"

def post(path, data):
    url = f"{FIREBASE_URL}/{path}.json"
    r = requests.post(url, json=data)
    return r.json()

def get(path):
    url = f"{FIREBASE_URL}/{path}.json"
    r = requests.get(url)
    return r.json()
