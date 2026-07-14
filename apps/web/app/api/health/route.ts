// Public liveness probe for container healthchecks: no auth, no DB — it only
// confirms the web process is serving. Operational/auth'd health (jobs, DB
// status) lives at /api/system/health.
export function GET() {
  return Response.json({ status: "ok" });
}
