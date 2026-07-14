/**
 * Smoke test for the onboarding gate. A freshly registered user (no
 * user_settings row) must be redirected from the app to /onboarding, and the
 * /onboarding page itself must render.
 *
 *   BASE_URL=http://localhost:3000 node scripts/verify-onboarding.mjs
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const failures = [];
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const cookies = new Map();
async function req(method, path, body, redirect = "follow") {
  const headers = { "content-type": "application/json", origin: BASE };
  if (cookies.size)
    headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    redirect,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const i = pair.indexOf("=");
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}

const email = `onb_${Date.now()}@kosh.test`;
const signup = await req("POST", "/api/auth/sign-up/email", {
  email,
  password: "supersecret123",
  name: "Onb",
});
check("sign-up succeeds", signup.status === 200, `status ${signup.status}`);

// New user, no settings row → /overview must redirect to /onboarding.
const overview = await req("GET", "/overview", undefined, "manual");
const location = overview.headers.get("location") ?? "";
check(
  "fresh user redirected away from /overview",
  overview.status >= 300 && overview.status < 400,
  `status ${overview.status}`,
);
check(
  "redirect target is /onboarding",
  location.includes("/onboarding"),
  `location ${location}`,
);

// The onboarding page itself renders for the logged-in user.
const onboarding = await req("GET", "/onboarding", undefined, "manual");
check("/onboarding renders (200)", onboarding.status === 200, `status ${onboarding.status}`);

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall onboarding gate checks passed");
