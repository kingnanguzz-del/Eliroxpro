const fs = require('fs');
const path = require('path');

/**
 * Simple JSON-file persistence. Honest limitation: Render's free-tier
 * filesystem is NOT guaranteed durable across full redeploys (a new deploy
 * can reset it) — but it DOES survive normal restarts/spin-downs during
 * the same deploy, which is what actually matters for "remembering
 * patterns" between your app-opening sessions. For guaranteed durability
 * across redeploys, this would need a real database (e.g. Render's free
 * Postgres, or MongoDB Atlas free tier) — worth upgrading to later if this
 * matters more than it does right now.
 */
const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'store.json');

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (err) {
    console.warn('Persistent store read failed, starting fresh:', err.message);
    return {};
  }
}

function saveStore(store) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (err) {
    console.warn('Persistent store write failed:', err.message);
  }
}

function get(key) {
  const store = loadStore();
  return store[key] ?? null;
}

function set(key, value) {
  const store = loadStore();
  store[key] = value;
  saveStore(store);
}

/**
 * Appends one entry to a growing log under `key` — this is the actual
 * "remembering patterns over time" mechanism: every trade's entry
 * features and outcome accumulate here, never overwritten, never removed.
 */
function appendLog(key, entry) {
  const store = loadStore();
  if (!store[key]) store[key] = [];
  store[key].push({ ...entry, loggedAt: Date.now() });
  saveStore(store);
  return store[key];
}

function getLog(key) {
  return get(key) || [];
}

module.exports = { get, set, appendLog, getLog };
