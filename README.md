# SkillSwap

A peer-to-peer skill exchange platform: list what you can teach and what you want to learn, get matched with
people whose skills complement yours, send an exchange request, and chat in real time once it is accepted.

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:3000>. Needs Node.js 18 or newer.

Your accounts, requests and messages are stored in `data/db.json`. The login-signing secret is created
automatically in `data/secret.txt` on first start. **Keep the `data/` folder private and never commit or share it.**

## Test it

```bash
npm test
```

Starts temporary servers (your real `data/` is never touched) and runs about 145 checks: sign-up/login rules,
token forgery attempts, brute-force lock-out, matching, requests, real-time chat over WebSockets, flood
protection, account deletion, restarts, damaged database files and rate limits.

## Settings (all optional environment variables)

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | Port to listen on | `3000` |
| `DATA_DIR` | Folder for `db.json` and `secret.txt` | `./data` |
| `JWT_SECRET` | Use this signing secret instead of `data/secret.txt` | auto-generated |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy so rate limits see real IPs | off |
| `LOGIN_IP_MAX` / `LOGIN_EMAIL_MAX` | Failed logins allowed per 15 min per IP / per email | `30` / `8` |
| `REGISTER_MAX` | Sign-ups per IP per hour | `20` |
| `API_MAX` | API calls per IP per minute | `600` |

Example (Windows PowerShell): `$env:PORT=4000; npm start`

## Project layout

```
server.js            Express API + Socket.IO chat + JSON-file database
public/              The website (served as static files)
  index.html  login.html  register.html  dashboard.html
  css/style.css  css/dashboard.css
  js/api.js          shared helpers (fetch wrapper, escaping, toasts)
  js/auth.js         login + sign-up pages
  js/main.js         landing page (typing effect, live stats, slider, mobile menu)
  js/dashboard.js    profile, matches, requests, real-time chat
test/api.test.js     automated tests
```

## How it works

* **Matching** compares what you teach with what others want to learn, and the reverse. A two-way match is a
  "perfect match". Skills are normalised, so `Front-End`, `front end` and `frontend` are the same skill.
* **Chat** unlocks only after the other person accepts your request. Only the two people involved can read or send
  messages, and online status is shared only with people you can chat with.
* **Declined requests** can be re-sent after 24 hours.

## Security notes

* Passwords are stored as bcrypt hashes (max 72 bytes). Logins are rate-limited per IP and per email.
* Login tokens (JWT, 30 days) are pinned to HS256 and the account must still exist.
* Content-Security-Policy and other security headers are sent on every response; all user text is rendered as
  plain text, never as HTML.
* Run it behind HTTPS if you put it on the internet (for example with a reverse proxy), otherwise passwords and
  tokens travel unencrypted.

## Known limits (good next steps)

* The JSON file database is perfect for a demo or a small group; for many users move to SQLite/PostgreSQL.
* Scheduling and ratings are advertised as "coming soon" on the home page and are not built yet.
* No password reset or email verification yet (it needs an email service).
* The login token is kept in `localStorage`; a hosted version could move it to an HttpOnly cookie.
