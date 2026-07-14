/**
 * In-memory job store. Fine for a single-instance Render deployment — jobs
 * are lost on restart, which is acceptable for a search you can just re-run.
 * If this ever needs to survive restarts, swap this for a database table.
 */
const jobs = new Map();

function createJob() {
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  jobs.set(id, { id, status: 'running', progress: 0, total: 1, result: null, error: null, startedAt: Date.now() });
  return id;
}

function updateProgress(id, progress, total) {
  const job = jobs.get(id);
  if (job) { job.progress = progress; job.total = total; }
}

function completeJob(id, result) {
  const job = jobs.get(id);
  if (job) { job.status = 'done'; job.result = result; job.finishedAt = Date.now(); }
}

function failJob(id, errorMessage) {
  const job = jobs.get(id);
  if (job) { job.status = 'error'; job.error = errorMessage; job.finishedAt = Date.now(); }
}

function getJob(id) {
  return jobs.get(id) || null;
}

// Basic cleanup: drop jobs older than 1 hour so memory doesn't grow forever.
// unref() so this timer doesn't keep the process (or a quick test script) alive.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.startedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

module.exports = { createJob, updateProgress, completeJob, failJob, getJob };
