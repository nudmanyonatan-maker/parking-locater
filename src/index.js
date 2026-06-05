import { getSpot, putSpot, deleteSpot } from "./spot.js";
import { shouldFireReminder, buildDiscordPayload, sendDiscord } from "./reminder.js";

const json = (data, status = 200) =>
  new Response(data === null ? "null" : JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function handleApi(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname !== "/api/spot") return json({ error: "not found" }, 404);

  if (request.method === "GET") {
    return json(await getSpot(env));
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return json({ error: "lat and lng are required numbers" }, 400);
    }
    const spot = {
      lat,
      lng,
      note: typeof body.note === "string" ? body.note : "",
      moveBy: body.moveBy == null ? null : Number(body.moveBy),
      createdAt: Date.now(),
      reminderSent: false,
    };
    await putSpot(env, spot);
    return json(spot);
  }

  if (request.method === "DELETE") {
    await deleteSpot(env);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

async function runReminderCheck(env) {
  const spot = await getSpot(env);
  if (!shouldFireReminder(spot, Date.now())) return;
  if (!env.DISCORD_WEBHOOK_URL) {
    console.error("DISCORD_WEBHOOK_URL not configured");
    return;
  }
  const ok = await sendDiscord(env.DISCORD_WEBHOOK_URL, buildDiscordPayload(spot));
  if (ok) {
    await putSpot(env, { ...spot, reminderSent: true });
  } else {
    console.error("Discord webhook POST failed; will retry next run");
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    // Requests that didn't match a static asset and aren't API calls.
    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminderCheck(env));
  },
};
