// Roue des Coalitions — serveur (Node.js >= 20, aucune dépendance npm).
// - Connexion : AUTH_PROVIDER=simple (par défaut) = on tape n'importe quel login, sans mot de passe.
//   AUTH_PROVIDER=42next = vraie connexion 42 Next (Keycloak, OpenID Connect) ;
//   AUTH_PROVIDER=intra  = ancienne intra (api.intra.42.fr).
// - Scores partagés stockés dans data/state.json.
// - Le tirage et l'attente de 30 s sont décidés ici, pas dans le navigateur (impossible de tricher).
"use strict";
try { process.loadEnvFile(); } catch { /* pas de fichier .env : valeurs par défaut */ }
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const RULES = require("./config.js");

// ===== Configuration (fichier .env) =====
const PORT = Number(process.env.PORT || 3000);
const PROVIDER = (process.env.AUTH_PROVIDER || "simple").toLowerCase();   // "simple", "42next" ou "intra"
const CLIENT_ID = process.env.FT_CLIENT_ID;
const CLIENT_SECRET = process.env.FT_CLIENT_SECRET;          // vide si le client 42 Next est "public" (PKCE seul)
const REDIRECT_URI = process.env.FT_REDIRECT_URI || `http://localhost:${PORT}/callback`;
// 42 Next : adresse du realm Keycloak
const OIDC_ISSUER = process.env.OIDC_ISSUER || "https://keycloak.prod.42.tech/realms/42Next";
// Restrictions d'accès (facultatives)
const ALLOWED_CAMPUS = (process.env.ALLOWED_CAMPUS || "Marseille").toLowerCase();               // intra seulement
const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || "").split(",").map(s => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
const ADMINS = (process.env.ADMINS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
if (PROVIDER !== "simple" && (!CLIENT_ID || (PROVIDER === "intra" && !CLIENT_SECRET))) {
  console.error("❌ FT_CLIENT_ID (et FT_CLIENT_SECRET) manquants. Copie .env.example en .env et remplis-le (voir README).");
  process.exit(1);
}
// Cookies "Secure" en HTTPS (Render : mettre COOKIE_SECURE=1, déjà fait dans render.yaml).
const SECURE_COOKIES = REDIRECT_URI.startsWith("https://") || process.env.COOKIE_SECURE === "1";

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SECRET_FILE = path.join(DATA_DIR, "session-secret");
const PUBLIC_DIR = path.join(__dirname, "public");
fs.mkdirSync(DATA_DIR, { recursive: true });

// Clé de signature des cookies de session (générée une fois, gardée dans data/).
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  SESSION_SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim();
}

// ===== État partagé =====
const emptyState = () => ({ scores: Object.fromEntries([...RULES.coalitions, "tig"].map(k => [k, 0])), history: [], nextSpin: {} });
let state = emptyState();

// Stockage : Upstash Redis si UPSTASH_REDIS_REST_URL/TOKEN sont définis (permanent, conseillé
// sur Render gratuit dont le disque est effacé à chaque mise en veille), sinon data/state.json.
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_KEY = process.env.REDIS_KEY || "roue-coalition:state";
const useRedis = Boolean(REDIS_URL && REDIS_TOKEN);
async function redis(cmd, body) {
  const r = await fetch(`${REDIS_URL}/${cmd}/${encodeURIComponent(REDIS_KEY)}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body,
  });
  if (!r.ok) throw new Error(`Upstash ${cmd} : ${r.status} ${await r.text()}`);
  return (await r.json()).result;
}
async function loadState() {
  try {
    const raw = useRedis ? await redis("get") : fs.readFileSync(STATE_FILE, "utf8");
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch (e) {
    if (useRedis) throw e;          // ne pas démarrer avec des scores vides si Redis est injoignable
    /* premier lancement : pas encore de fichier */
  }
}
// Sauvegardes l'une après l'autre (jamais deux écritures en même temps).
let saving = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(state);
  saving = saving.then(async () => {
    if (useRedis) return redis("set", snapshot);
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, snapshot);
    fs.renameSync(tmp, STATE_FILE);
  }).catch(e => console.error("❌ sauvegarde des scores :", e.message));
  return saving;
}

// Un tirage n'est montré aux autres qu'une fois l'animation du lanceur terminée.
function publicState(login) {
  const now = Date.now();
  const scores = { ...state.scores };
  const history = [];
  for (const h of state.history) {
    if (h.revealAt > now && h.login !== login) {
      if (h.tig) scores.tig -= h.tig; else scores[h.coal] -= h.pts;
    } else if (history.length < 15) {
      history.push({ login: h.login, coal: h.coal, pts: h.pts, tig: h.tig, at: h.revealAt });
    }
  }
  return { scores, history };
}

// Tirage : TIG avec la probabilité tigChance, sinon une case coalition au hasard (toutes égales).
function draw() {
  if (crypto.randomInt(1_000_000) < RULES.tigChance * 1_000_000) return { tig: 1 };
  const coal = RULES.coalitions[crypto.randomInt(RULES.coalitions.length)];
  const pts = RULES.values[crypto.randomInt(RULES.values.length)];
  return { coal, pts };
}

// ===== Sessions (cookie signé HMAC) =====
const b64u = buf => Buffer.from(buf).toString("base64url");
const sign = data => crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");
function makeCookie(obj) { const d = b64u(JSON.stringify(obj)); return `${d}.${sign(d)}`; }
function readCookie(v) {
  if (!v) return null;
  const [d, s] = v.split(".");
  if (!d || !s) return null;
  const good = sign(d);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(d, "base64url").toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function setCookie(res, name, value, maxAgeS) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeS}`];
  if (SECURE_COOKIES) parts.push("Secure");
  const prev = res.getHeader("Set-Cookie") || [];
  res.setHeader("Set-Cookie", [...prev, parts.join("; ")]);
}
const sessionOf = req => readCookie(cookies(req).session);

// ===== Réponses =====
function send(res, code, body, type = "text/html; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
const redirect = (res, to) => { res.writeHead(302, { Location: to }); res.end(); };
const file = name => fs.readFileSync(path.join(PUBLIC_DIR, name));
const LOGIN_FORM = PROVIDER === "simple"
  ? `<form method="post" action="/login"><input name="login" placeholder="Ton login" required maxlength="20" pattern="[A-Za-z0-9_\\-]{2,20}" autocomplete="username" autofocus><button type="submit">Entrer</button></form>`
  : `<a class="btn" href="/login"><span class="logo">42</span> Se connecter avec 42</a>`;
const loginPage = (msg = "") => file("login.html").toString().replace("<!--MSG-->", msg).replace("<!--LOGIN-->", LOGIN_FORM);
// En mode simple, n'importe qui peut taper n'importe quel login : pas d'admin (sinon tout le monde le serait).
const isAdmin = login => PROVIDER !== "simple" && ADMINS.includes(login.toLowerCase());
function readBody(req, max = 2048) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", c => { d += c; if (d.length > max) { reject(new Error("trop gros")); req.destroy(); } });
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}
async function simpleLogin(req, res) {
  const login = String(new URLSearchParams(await readBody(req)).get("login") || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,20}$/.test(login)) return send(res, 400, loginPage("Login invalide (2 à 20 caractères : lettres, chiffres, - ou _)."));
  setCookie(res, "session", makeCookie({ login, id: login, img: null, exp: Date.now() + 7 * 24 * 3600e3 }), 7 * 24 * 3600);
  console.log(`connecté : ${login}`);
  res.writeHead(303, { Location: "/" }); res.end();
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ===== Connexion =====
// Endpoints : 42 Next = découverte OpenID Connect ; intra = URLs fixes.
let oidc = null;
async function endpoints() {
  if (PROVIDER === "intra") return {
    authorize: "https://api.intra.42.fr/oauth/authorize", token: "https://api.intra.42.fr/oauth/token",
    userinfo: "https://api.intra.42.fr/v2/me", scope: "public",
  };
  if (!oidc) {
    const r = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`);
    if (!r.ok) throw new Error(`découverte OIDC impossible (${r.status})`);
    const d = await r.json();
    oidc = { authorize: d.authorization_endpoint, token: d.token_endpoint, userinfo: d.userinfo_endpoint, scope: "openid profile email" };
  }
  return oidc;
}
const pkcePair = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};

async function startLogin(req, res) {
  const ep = await endpoints();
  const st = crypto.randomBytes(16).toString("hex");
  const { verifier, challenge } = pkcePair();
  // state + code_verifier gardés 10 min dans un cookie signé
  setCookie(res, "oauth", makeCookie({ st, verifier, exp: Date.now() + 600e3 }), 600);
  const q = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", scope: ep.scope, state: st });
  if (PROVIDER !== "intra") { q.set("code_challenge", challenge); q.set("code_challenge_method", "S256"); }
  redirect(res, `${ep.authorize}?${q}`);
}

// Renvoie { login, id, img, email, campuses } à partir du profil du fournisseur.
function normalizeUser(me) {
  if (PROVIDER === "intra") return { login: me.login, id: me.id, img: me.image?.versions?.small || null, email: me.email, campuses: (me.campus || []).map(c => String(c.name).toLowerCase()) };
  return { login: me.preferred_username || me.email || me.sub, id: me.sub, img: me.picture || null, email: me.email, campuses: null };
}

async function handleCallback(req, res, url) {
  const st = url.searchParams.get("state"), code = url.searchParams.get("code");
  const saved = readCookie(cookies(req).oauth);
  setCookie(res, "oauth", "", 0);
  if (url.searchParams.get("error")) return send(res, 400, loginPage("Connexion annulée."));
  if (!code || !st || !saved || st !== saved.st) return send(res, 400, loginPage("La connexion a expiré, réessaie."));

  const ep = await endpoints();
  const form = { grant_type: "authorization_code", client_id: CLIENT_ID, code, redirect_uri: REDIRECT_URI };
  if (CLIENT_SECRET) form.client_secret = CLIENT_SECRET;
  if (PROVIDER !== "intra") form.code_verifier = saved.verifier;
  const tokRes = await fetch(ep.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  if (!tokRes.ok) { console.error("token", tokRes.status, await tokRes.text()); return send(res, 502, loginPage("Erreur avec le serveur de connexion 42, réessaie.")); }
  const { access_token } = await tokRes.json();

  const meRes = await fetch(ep.userinfo, { headers: { Authorization: `Bearer ${access_token}` } });
  if (!meRes.ok) { console.error("userinfo", meRes.status, await meRes.text()); return send(res, 502, loginPage("Erreur avec le serveur de connexion 42, réessaie.")); }
  const me = normalizeUser(await meRes.json());
  if (!me.login) return send(res, 502, loginPage("Profil 42 incomplet."));

  // Restrictions : campus (intra) et/ou domaine de l'e-mail (si ALLOWED_EMAIL_DOMAINS est rempli).
  const domain = String(me.email || "").toLowerCase().split("@")[1] || "";
  const campusOk = !me.campuses || me.campuses.includes(ALLOWED_CAMPUS);
  const emailOk = !ALLOWED_EMAIL_DOMAINS.length || ALLOWED_EMAIL_DOMAINS.includes(domain);
  if (!campusOk || !emailOk) {
    console.log(`refusé : ${me.login} (campus : ${me.campuses?.join(", ") ?? "-"}, e-mail : ${domain || "-"})`);
    return send(res, 403, loginPage(`Désolé <b>${esc(me.login)}</b>, la roue est réservée aux étudiant·e·s de 42 Marseille.`));
  }
  const user = { login: me.login, id: me.id, img: me.img, exp: Date.now() + 7 * 24 * 3600e3 };
  setCookie(res, "session", makeCookie(user), 7 * 24 * 3600);
  console.log(`connecté : ${me.login}`);
  redirect(res, "/");
}

// ===== Routes =====
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const user = sessionOf(req);
    const p = url.pathname;

    if (p === "/healthz") return send(res, 200, "ok", "text/plain");
    if (req.method === "GET" && p === "/config.js") return send(res, 200, file("../config.js"), "text/javascript; charset=utf-8");

    if (PROVIDER === "simple") {
      if (req.method === "POST" && p === "/login") return await simpleLogin(req, res);
    } else {
      if (req.method === "GET" && p === "/login") return await startLogin(req, res);
      if (req.method === "GET" && p === new URL(REDIRECT_URI).pathname) return await handleCallback(req, res, url);
    }
    if (p === "/logout") { setCookie(res, "session", "", 0); return redirect(res, "/"); }

    if (req.method === "GET" && p === "/") return user ? send(res, 200, file("index.html")) : send(res, 200, loginPage());

    // --- API (connecté uniquement) ---
    if (p.startsWith("/api/")) {
      if (!user) return json(res, 401, { error: "non connecté" });
      // Protection CSRF simple : les POST doivent venir de la page (en-tête personnalisé).
      if (req.method === "POST" && req.headers["x-roue"] !== "1") return json(res, 403, { error: "requête refusée" });

      if (req.method === "GET" && p === "/api/state") {
        const waitMs = Math.max(0, (state.nextSpin[user.login] || 0) - Date.now());
        return json(res, 200, { ...publicState(user.login), me: { login: user.login, img: user.img, admin: isAdmin(user.login) }, waitMs });
      }
      if (req.method === "POST" && p === "/api/spin") {
        const now = Date.now();
        const next = state.nextSpin[user.login] || 0;
        if (now < next) return json(res, 429, { error: "attends", waitMs: next - now });
        const result = draw();
        if (result.tig) state.scores.tig += result.tig; else state.scores[result.coal] += result.pts;
        state.history.unshift({ ...result, login: user.login, revealAt: now + RULES.spinMs });
        state.history = state.history.slice(0, 200);
        state.nextSpin[user.login] = now + RULES.spinMs + RULES.cooldownS * 1000;
        save();
        console.log(`tirage : ${user.login} -> ${result.tig ? "TIG" : `${result.coal} ${result.pts}`}`);
        return json(res, 200, { result, waitMs: RULES.spinMs + RULES.cooldownS * 1000, ...publicState(user.login) });
      }
      if (req.method === "POST" && p === "/api/reset") {
        if (!isAdmin(user.login)) return json(res, 403, { error: "réservé aux admins" });
        state = emptyState();
        save();
        console.log(`scores remis à zéro par ${user.login}`);
        return json(res, 200, publicState(user.login));
      }
    }
    send(res, 404, "Introuvable", "text/plain; charset=utf-8");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, "Erreur serveur", "text/plain; charset=utf-8");
  }
});
loadState().then(() => server.listen(PORT, () => console.log(`🎡 Roue des Coalitions : http://localhost:${PORT}  (stockage : ${useRedis ? "Upstash Redis" : STATE_FILE} ; connexion : ${PROVIDER === "simple" ? "simple, n'importe quel login" : PROVIDER === "intra" ? `intra 42, campus ${ALLOWED_CAMPUS}` : `42 Next (${OIDC_ISSUER})`}${ALLOWED_EMAIL_DOMAINS.length ? `, e-mails @${ALLOWED_EMAIL_DOMAINS.join(", @")}` : ""})`)), e => { console.error("❌ impossible de charger les scores :", e.message); process.exit(1); });
