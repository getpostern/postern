<!-- Verified against gateway source fd3d5d1 and the witness evidence, 2026-08-08.
     Executed on a clean machine 2026-08-08 (first-time user, Codex agent) through install, six
     sources, and agent wiring — Apple Health and the Phase 4 read-back were not reached in that
     run. Its feedback is folded in. Ships via #145. -->

# Set up Postern with your coding agent

**For the person reading this.** Point your coding agent — Claude Code, Cursor, Codex, or anything that can read files and run commands — at this file and say: *"Follow this file and set Postern up for me."* The agent does every step a program can do: the install (Docker included, with your go-ahead), the gateway calls, and the checks that prove each step worked. You do the steps only you can do: signing in to your accounts, approving what they share, and pasting secrets into Postern's own screens — never into the chat.

Honestly stated: an agent can do about 95% of getting Postern running and connected to itself, and about half of connecting it to your life. You sign in to each provider yourself.

The same path written for people, screen by screen, is the documentation at **https://docs.getpostern.com**. This file leans on it rather than repeating it.

**For the agent.** You are setting Postern up on behalf of the person at the keyboard, on the machine you are running on. Rules of engagement:

- Work through the phases in order. Stop at every block marked **HUMAN**: say what is needed and why, then wait. Do not attempt the human steps; do not hand off your own.
- Pace the person, do not drip-feed them. Batch short, reversible steps — navigation, clicks, form fields — as one numbered list, and every batch names the machine, the application, and what the person should see at the end. Break the batch at every consequential moment: a password or one-time secret, an OAuth consent, a purchase or plan choice, a permission grant, anything destructive. Those get their own stop.
- This file assumes a POSIX shell — macOS, Linux, or WSL on Windows. Postern under plain Windows is untested; say so rather than improvising PowerShell.
- The admin surface is loopback-only and has no authentication — reaching the port *is* the authorization. You must be on the same machine as the gateway, or behind a port-forward that preserves `Host: localhost` (such as `ssh -L`). A reverse proxy or `tailscale serve` rewrites the Host header, and every admin call then returns `403 {"error":"forbidden host"}` — that is by design, and widening `REST_ALLOWED_HOSTS` to get around it is forbidden (Never rule 4).
- Every command, route, payload, and response body in this file was read from the gateway's source (verified against `fd3d5d1`, 2026-08-08). If the gateway answers something this file does not predict, stop and show the person the exact response instead of improvising.
- Every docs page also serves plain Markdown at the same address with `.md` appended (`…/connect/microsoft.md`). If your web tool refuses a page or returns raw HTML, fetch the `.md` form instead — in the recorded setup run the web tool refused the HTML pages outright, and a plain `curl` of the `.md` form returned clean Markdown every time.
- The base URL below is `http://localhost:8787`. Two ports matter and both are knobs: `REST_PORT` (default 8787 — the admin surface and Console) and `MCP_HTTP_PORT` (the agent endpoint — the shipped compose file sets it to 8788; outside compose, an unset `MCP_HTTP_PORT` means no agent endpoint at all, not a default). If either moved, substitute everywhere. One exception: the OAuth `redirectUri` the gateway returns already reflects the real port — **never edit what `GET /api/oauth/<provider>/app` returns**; if it looks wrong, stop and show the person.

## Never do these

Each line guards against something that has actually destroyed data or published a private surface.

1. **Never remove, prune, or recreate a Docker volume belonging to this stack — by any command.** Not `docker compose down -v`, not `down --volumes`, not `rm -v`, not `volume prune`, not `system prune --volumes`. The stack has two volumes, suffixed `_pgdata` (the cached data) and `_pci_master_key` (the vault key — lose it and every stored credential becomes permanently undecryptable). The one exception is the explicitly gated recovery in Phase 0, which touches `_pgdata` only.
2. Never call `GET /api/export` or `POST /api/erase` — not even "to check". One returns the person's entire store; the other is a hard delete with no undo.
3. A secret that has a Console field belongs in that field, pasted there by the person — not in the chat, not in your tool calls. When you must handle one (a key the person asks you to place, a value an API returns), it may exist in exactly two places: the request that uses it, and the one config entry it belongs in. Never repeat one in a summary or report, never write one to notes, scratch files, or anything committed. Whatever does pass through your tool calls will sit in your transcript and the shell history — keep that set as close to empty as the flow allows.
4. Never widen `REST_ALLOWED_HOSTS`, the compose port publish, or a bind address to make something reachable. The allowlist widens what is *accepted*; it adds no authentication.
5. Never send `acknowledged: true` to `POST /api/exposure`. The API will accept it from anything on loopback — including you. It is a consent field, not a lock: the only thing enforcing that the *person* decided to publish their gateway to the internet is you refusing to send it. Publishing is decided in the Console.
6. Never open a sign-in or consent window — an OAuth `authorizationUrl` or Plaid's `hostedLinkUrl` — before the person says they are ready. The OAuth window is 10 minutes, single-use, and lost if the gateway restarts. And when you hand one over, print it as plain text in a code block, never as a clickable link: a chat client's link preview can consume the single-use URL before the person ever clicks. In the recorded run a consent died 90 seconds after minting to exactly this; the plain-text retry worked.
7. Never mint or rotate an agent key without `expiresInDays`. Omitting it creates — or on a re-POST, silently resets to — a key that never expires, which cloud clients refuse at sign-in. (In the Console the person may choose **Never** themselves — that is their call, not yours.) To change a deadline or a grant, use `PATCH` (Phase 3); a re-POST replaces the key itself.

## Phase 0 — look before you touch

**HUMAN — first, establish where things are.** Two questions, because almost everything below depends on the answers:

- **Which machine will Postern run on?** This one, or another (a spare computer, a NAS, a home server)? Postern supports either. But you must be running *on that machine* — over SSH is fine — because the admin surface answers only to loopback. If you are not, stop and say so.
- **Will the person's web browser be on that same machine?** They need a browser that reaches the gateway for two things: the Console, and every provider sign-in. If their browser is somewhere else — Postern on a headless box, them on a laptop — they need a port-forward before the sign-ins in Phase 2 — the `ssh -N -L` command at the end of Phase 1. Establish this now rather than discovering it half-way through a 10-minute consent window.

1. **The tools this file uses, actually working.** Confirm each answers before anything else:
   - `docker info` must succeed — `docker compose version` succeeds even with the daemon stopped, so it proves nothing. "Cannot connect to the Docker daemon" means the engine is installed but stopped: start it (Docker Desktop, or `brew services start colima`). Not installed at all → the install block below.
   - `curl --version` must succeed.
   - (`openssl` is checked at the moment it is used, in Phase 1 — its check is written into the commands there. `git` is needed only for the optional checkout route in Phase 1.)

   **If Docker is missing, install it yourself — with consent, not silently.** Name what you will install and how, and get a yes before the first command; substituting one engine for another is part of that ask, not a silent swap. On macOS with Homebrew present, this path needs no administrator password and no GUI, and is the one proven on a clean machine:

   ```bash
   brew install colima docker docker-compose
   ```

   Then make the compose plugin discoverable — create `~/.docker/config.json` with exactly this, or **merge** the key into the existing file (never overwrite one that exists):

   ```json
   { "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"] }
   ```

   (That is the Apple-silicon path; on an Intel Mac Homebrew's prefix makes it `/usr/local/lib/docker/cli-plugins`. `brew info docker-compose` prints the right one.) Then start the engine as a service:

   ```bash
   brew services start colima
   ```

   The first start downloads and boots a Linux VM — about 40 seconds on a fast connection. While it does, `colima status` prints `level=fatal msg="colima is not running"`: that is the download, not a failure. Do not reinstall or re-run; watch `$(brew --prefix)/var/log/colima.log` and wait until `docker info` exits 0. Colima switches the active Docker context itself.

   Say three things out loud while it boots:
   - `brew services` makes a **login** service, not a boot service. On a machine nobody logs into — a headless mini — expect the gateway to stay down after a reboot until someone logs in (inferred from how the service registers; a reboot was not tested in the recorded run).
   - Colima's default VM is 2 CPUs and about 2 GiB of memory — enough for the recorded setup; nothing heavier was tried.
   - If a source on the local network (Home Assistant) is connected later, macOS may gate the VM's LAN access behind a privacy permission — the fix is in the troubleshooting table, and it is a GUI step only the person can do.

   The alternatives, for completeness: **Docker Desktop** (`brew install --cask docker-desktop`; the old cask name `docker` still resolves; needs macOS 14+, cask 4.85.0 checked 2026-08-08; without Homebrew, the installer lives at https://docs.docker.com/get-started/get-docker/) can demand an administrator password mid-install — on the recorded clean machine it died when the cask needed sudo to create `/usr/local/bin`, because an agent's shell has no terminal for the password prompt, and Homebrew rolled it back cleanly. If the person prefers Docker Desktop, they run that install or sit at the prompt; you do not. **No Homebrew at all** → installing it (https://brew.sh) needs the person and their administrator password; hand them the link, wait, re-check. **Linux / WSL** → engine install is distro-specific and unwitnessed by this file: https://docs.docker.com/engine/install/ is their step; wait, then re-check.

2. **An existing install.** Check, in order:
   - `curl -s http://localhost:8787/healthz` returns `{"status":"ok"}` → Postern is already running. Ask the person where the install directory lives — the folder holding `docker-compose.yml` and `.env`; the fixes further down need it — then pick up at the Console handoff at the end of Phase 1 ("Finish by getting the person into the Console") and go on to Phase 2.
   - An install directory with a `.env` already exists (ask the person where it is — do not fetch a second copy) → resume Phase 1 at `docker compose up -d` from that directory.
   - A volume suffixed `_pgdata` exists from a previous Postern install, but there is no `.env` (or compose refuses with `set POSTGRES_PASSWORD in .env`) → a previous start was given a password nobody recorded, and Postgres keeps the first password it is ever given. **Recovery is destructive and gated:**
     - First, try recovery without destruction: the original password may still exist — in a shell history, a backup, the person's memory. If found, write it into `.env` and resume.
     - Only if it cannot be found, **and** the person confirms they never connected any source (nothing cached to lose): run `docker volume inspect` on the candidate volume, show the person its exact name and creation date, and get their explicit yes **on that name** — a developer machine can carry several `_pgdata` volumes and this file must not guess. Then — because compose subcommands refuse to run with no variable at all — write `POSTGRES_PASSWORD=placeholder` into `.env` first, then `docker compose down` (never `-v`), `docker volume rm <that exact volume>`, and Phase 1 from the `.env` step, which overwrites the placeholder with a real password.
     - If they *had* connected sources, stop. Write a placeholder line into `.env` first — `POSTGRES_PASSWORD=placeholder` — so `docker compose` subcommands work again (Postgres ignores the env value after first boot; the volume keeps its real password), then hand them the backup guide before anything else happens: https://docs.getpostern.com/operate/backup-and-export — and do not `docker compose up` with the placeholder in place: the app would fail against the volume's real password and restart-loop.
3. **The ports.** Check that 8787 **and** 8788 are free — `nc -z 127.0.0.1 8787`, or `lsof -i :8787`, or any probe you have; the tool does not matter, the answer does. If either is taken, note a free port now — you will write `REST_PORT=` / `MCP_HTTP_PORT=` into `.env` in Phase 1, *after* the install directory exists. Do not create a `.env` anywhere else.

## Phase 1 — install and verify

Three steps. Each must succeed before the next — never run the later ones after an earlier one failed. All of them run in the install directory; if your shell resets its working directory between commands, begin every block by changing into it.

**1. Fetch.** The gateway ships as a prebuilt image (`ghcr.io/getpostern/postern`); the only file the stack needs is `docker-compose.yml`. From wherever the person wants Postern to live (their home directory is a fine default):

```bash
mkdir -p ~/postern && cd ~/postern
curl -fsSLO https://raw.githubusercontent.com/getpostern/postern/main/docker-compose.yml
```

A full checkout does the same job if the person prefers one: `git clone https://github.com/getpostern/postern.git` (on a brand-new Mac the first `git` run pops a dialog offering to install the command line tools — that install is the person's click). If the directory already holds a compose file, do not fetch over it — that is the resume case in Phase 0.

**2. The password file.** This line is load-bearing: compose refuses to start without the variable, and the database keeps the first password it is ever given — so it must live in a file every later start reads, never in front of a command.

```bash
cd ~/postern    # the install directory from step 1
umask 077
printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > .env
grep -Eq '^POSTGRES_PASSWORD=[0-9a-f]{48}$' .env || { echo "STOP: password was not generated"; exit 1; }
```

The `umask` makes `.env` readable by this user alone. The check matters: if `openssl` is missing, the substitution silently yields an empty value, and an empty password would be pinned into the volume forever. If the check fails, stop and fix (any 48-hex-char generator will do) — do not continue. Hex only: base64 contains `/` and `+`, which break the database URL.

If Phase 0 found a port conflict, append — `>` here would erase the password line:

```bash
printf 'REST_PORT=%s\n' "<free port>" >> .env        # only if 8787 was taken
printf 'MCP_HTTP_PORT=%s\n' "<free port>" >> .env    # only if 8788 was taken
```

**3. Start.** From the install directory: `docker compose up -d` — and it must exit 0. `Bind for 127.0.0.1:<port> failed: port is already allocated` means fix the port in `.env` and re-run. Do not start polling until it has exited cleanly.

**Wait for readiness** by polling every 2 seconds:

```bash
curl -s -o /dev/null -w '%{http_code}' http://localhost:8787/healthz
```

| code | it means | do |
|---|---|---|
| `000` | nothing listening — booting (migrations run before the port opens) | keep waiting; confirm `docker compose ps` shows both containers |
| `200` | ready — body is `{"status":"ok"}` | continue |
| `503` | read the body: `{"status":"unavailable"}` = cannot reach its database; `{"status":"shutting_down"}` = it is stopping | `docker compose logs --tail=50 db app` |

There is no other body, and no "migrating" status — during migration nothing is listening at all.

Ceiling: about three minutes — the recorded clean-machine start, image pull included, took under thirty seconds, but a slow connection legitimately takes far longer on the first pull. **At the ceiling, tear nothing down.** Run `docker compose ps` and `docker compose logs --tail=50 app db`: if the image is still pulling, that is not a failure — keep waiting. Otherwise show the person the log.

Finish by getting the person into the Console, which answers at `http://localhost:8787` **and only on the machine Postern runs on**. (8787 is `REST_PORT` — if Phase 1 step 2 moved it, substitute the real value in the URL and on both sides of the forward below.)

- **Their browser is on that machine:** tell them to open **http://localhost:8787**.
- **Their browser is elsewhere** (Postern on a spare box or a NAS): they run this on their own computer, and leave it running —

  ```bash
  ssh -N -L 127.0.0.1:8787:127.0.0.1:8787 <user>@<the machine Postern runs on>
  ```

  Then `http://localhost:8787` opens on their computer too. Full instructions: https://docs.getpostern.com/start/install#open-console

  This forward is not a nicety. It preserves the `Host: localhost` header the admin surface requires, and it is what makes provider sign-ins work in Phase 2. A `tailscale serve` address or any reverse proxy rewrites that header and is refused — see the rules of engagement above. Even a tailnet the person already uses does not replace this forward for the Console.

When you hand this over, present it as one numbered batch: which machine each command runs on, which application, and what they should see at the end (the Console's first-run screen). This exact handoff confused the first real user when it arrived as prose.

Everything you do below is visible in the Console.

## Phase 2 — connect the person's life

**HUMAN** — ask what they want to connect, then go source by source. The division of labour, learned from the first real setup: **the person does every sign-in and pastes every secret into the Console's own forms; you verify each connection from the API.** Secrets that go person → Console never touch the chat at all. Drive the HTTP yourself only where a value is not a secret (an OAuth client ID), or where the person explicitly asks you to — the exact calls are given per source below. Their half is documented screen by screen in the docs — link them the page and quote only what the moment needs.

The Console path to every source form starts the same way, and after the first source it is no longer offered on the home page — name it every time: left rail → **Sources** → **Add a source** (top right) → the provider's card.

**After each source, ask: connect another, or done?** Stopping after one — mail alone — is a complete, valid setup, not a half-finished one.

Two different onboarding shapes, and the strings are exact (underscores included; nothing validates them — a misspelling creates a healthy-looking connection that never syncs):

- **These take the credential route** (`POST /api/credentials`): `simplefin` · `apple_health` · `gmail` · `home_assistant`
- **`apple` has its own onboarding route** — `POST /api/onboard/apple` creates the credential and all three connections in one transaction; never `POST /api/credentials` or `POST /api/connectors` for apple.
- **These never touch either** — they have their own routes below: `google` · `microsoft` · `whoop` (via `/api/oauth/...`) and `plaid` (via `/api/plaid/...`). Do not "fall back" to `/api/credentials` for them; it would 201 and never sync.

Where a response carries `connectionId`, that is the id every later per-connection call takes (`/sync`, `/webhook`, disconnect). `POST /api/connectors` returns `201 {"connectionId", "sector", "provider", "status"}`.

When a step says to open a URL for the person: print it and ask them to open it (as plain text — Never rule 6). Open it yourself only when you have confirmed you are in a desktop session with a browser — a silent no-op here burns a consent window.

**Before the first provider sign-in, confirm the person's browser can reach the gateway.** Ask them to load `http://localhost:8787` and tell you what they see. Every OAuth sign-in below ends with the provider redirecting *their browser* to `http://localhost:<REST_PORT>/api/oauth/<provider>/callback` — a fixed address the gateway never derives from the request, so it cannot adapt to where they happen to be. If their browser is not on the gateway's machine and has no port-forward, the sign-in will succeed at the provider and then land on nothing, the consent is lost, and the 10-minute window has to be started again. The forward is at the end of Phase 1. Do this check once, before the first OAuth source, rather than after a failure.

### iCloud mail, calendar and contacts — one paste

**HUMAN** — at https://account.apple.com/account/manage: **Sign-In & Security** → the **App-Specific Passwords** card → **View details**. What they see next branches on the account's history — both states were hit in real setups:

- No app-specific password exists yet → the button is **Generate an app-specific password**.
- One or more already exist → the button is the **+**.

Name it (for example `Postern`) → re-enter the account password. The password shows once — four groups of four lowercase letters, hyphenated — and the reveal screen has **no copy button**: select and copy the text before pressing **Done**. Then, in the Console: **Sources** → **Add a source** → **iCloud**, and paste it there. One paste creates three read-only connections at once (mail, calendar, contacts). Guide: https://docs.getpostern.com/connect/icloud

**AGENT** — verify with `GET /api/connectors`: expect three `apple` rows sharing one credential. If the person asks you to drive instead, the one exact call — it creates the connections itself; do **not** also call `POST /api/connectors` for apple:

```
POST /api/onboard/apple
{"appleId": "<their iCloud address>", "appSpecificPassword": "<the password>"}
```

→ `201 {credentialId, provider: "apple", connectors: [...]}`.

A first sync that fails with `apple: DAV connect failed` (or `apple: DAV account discovery failed`, or `icloud-mail: sync failed`) while every credential still reads `active` means iCloud did not accept the password — the gateway deliberately masks Apple's detail, so no more precision is available. The witnessed remedy: redo the Console form — the reconnect replaces the sealed secret in place, same three connections, nothing to delete. Have them generate a fresh app-specific password if there is any doubt the first was copied whole.

### SimpleFIN — banks without a developer account

*(Choosing between SimpleFIN and Plaid? Read the money comparison in the Plaid section below first, and bring it to the person before naming either brand.)*

**HUMAN** — at SimpleFIN Bridge, https://bridge.simplefin.org (it forwards to `beta-bridge.simplefin.org` — that is the right site): create the account, link their banks, then on **My account** press **New app connection** — not "New connection", which adds another bank — and **Create Setup Token**. The token shows once. Paste it in the Console: **Sources** → **Add a source** → **SimpleFIN**. Guide: https://docs.getpostern.com/connect/simplefin

**AGENT** — verify with `GET /api/connectors`. Driving on request (only when the person explicitly asks — Never rule 3 governs the value afterwards):

```
POST /api/credentials   {"provider": "simplefin", "secret": "<setup token>"}
POST /api/connectors    {"credentialId": "<from the 201>", "sector": "finance"}
```

The setup token is single-use; the gateway claims it into an access URL as it seals it. A reused or mangled paste fails at that claim — ask for a fresh token.

### Home Assistant

**HUMAN** — in Home Assistant: their own name at the bottom of the sidebar → the **Security** tab → at the bottom, **Long-lived access tokens** → **Create token** → name it → copy it (shown once). Also needed: the instance's address as a LAN IP, for example `http://192.168.1.50:8123` — not a `.local` name, which does not resolve inside a container. The address lives at **Settings → System → Network**; that page shows several addresses, so tell them plainly: the IPv4 address of the adapter that is connected. Then, in the Console: **Sources** → **Add a source** → **Home Assistant** → the **Instance URL** and **Long-lived token** fields → **Connect Home Assistant**. Guide: https://docs.getpostern.com/connect/home-assistant

**AGENT** — verify with `GET /api/connectors`. Home Assistant is a *streaming* source: healthy is `freshness` `ok` with `stream_state` `"connected"` and a climbing `cached_count` — and `POST /sync` never pulls for it (`ran: false`, `"event-driven connector; no manual pull"`). A row that sits at `unreachable` with `stream_state` `"down"` while every cloud source stays green is the LAN-reachability trap — see the troubleshooting row for Home Assistant `unreachable`. When the engine is a VM (colima), check the macOS Local Network permission first: it is free, it is a GUI step only the person can do, and in the recorded setup allowing it fixed the connection immediately. Driving on request (only when the person explicitly asks — Never rule 3 governs the value afterwards):

```
POST /api/credentials   {"provider": "home_assistant", "secret": "<token>", "instanceUrl": "http://<lan-ip>:8123"}
POST /api/connectors    {"credentialId": "...", "sector": "home"}
```

Home is the one sector with actions, not just reads — https://docs.getpostern.com/reference/mcp-actions.

### Gmail — an app password, not OAuth

Postern asks for no Gmail OAuth scope, ever, by design; mail comes over IMAP with an app password.

**HUMAN** — 2-Step Verification must be ON first: without it the App passwords page does not exist — it does not even appear in account search. Turning it on does not create the password; **they create it themselves afterwards**, at https://myaccount.google.com/apppasswords (go directly — searching the Security page won't find it). Then, in the Console: **Sources** → **Add a source** → **Gmail** → the **Gmail address** and **App password** fields. Say the warning out loud, because the form has been mistaken for a Google sign-in: **the App password field takes the 16-character generated password, never their normal Google password.** Postern never sees the Google password. Guide: https://docs.getpostern.com/connect/google

**AGENT** — verify with `GET /api/connectors`. Driving on request (`username` is mandatory for gmail — the full address):

```
POST /api/credentials   {"provider": "gmail", "secret": "<app password>", "username": "<full gmail address>"}
POST /api/connectors    {"credentialId": "...", "sector": "mail"}
```

### Google Calendar and Contacts — their own Google Cloud app

The longest human half (about 20 minutes). Do not paraphrase it — the guide walks every screen: https://docs.getpostern.com/connect/google

**AGENT, first** — read the redirect URI; never compose or edit it:

```
GET /api/oauth/google/app    → {..., "redirectUri": "..."}
```

**HUMAN** — following the guide: create a Google Cloud project, enable the two APIs the guide names (Calendar, and People — not the deprecated Contacts API), configure the consent screen, **add their own email as a test user**, and create an OAuth client — pasting the `redirectUri` you just read, character for character. Three traps the first real setup hit, worth saying before the screens:

- If a named product (Google Auth Platform, the consent screen) is not in the left menu, the reliable route is the Cloud Console's **top search bar** — search **OAuth consent screen** and open that result.
- The client form has two near-identical URI sections with identical **Add URI** buttons. **Authorized JavaScript origins stays empty**; the callback goes only under **Authorized redirect URIs** — an origin cannot carry a path, so the wrong box will not hold it. If it landed there anyway, delete it with the trash-can icon and re-add it under the second section.
- On Google's "hasn't verified this app" interstitial, the way forward is **Continue**; the help links open articles and grant nothing.

They return with a client ID and a client secret (the secret shows once at Google) — both pasted into the Console's Google form, not into chat.

**AGENT** — if the person asks you to drive the app config: `POST /api/oauth/google/app {"clientId": "...", "clientSecret": "..."}`. Then ask: *"Ready to sign in? The window is 10 minutes."* Only on yes:

```
GET /api/oauth/google/start  → {"authorizationUrl": "..."}
```

Hand it over as plain text (Never rule 6). They open it and approve; the callback creates the connections. Verify with `GET /api/connectors`.

Pass on two Google facts: while the app's publishing status is Testing only listed test users can approve, and Google expires the consent weekly until the app is published to production (guide § publish — the publish page is reached the same way, top search → **OAuth consent screen** → **Audience**).

### Microsoft — mail, calendar and contacts

Same shape as Google, two differences: registration is at Microsoft Entra, and there is **no client secret** — Postern is a public client using PKCE, and the gateway rejects a secret for microsoft.

**AGENT** — `GET /api/oauth/microsoft/app` → read `redirectUri`.

**HUMAN** — register the app per https://docs.getpostern.com/connect/microsoft with that literal redirect URI. One wall to expect: a brand-new personal Microsoft account cannot register applications — the registration dialog names the two ways out, the M365 Developer Program and an Azure sign-up (the published guide shows this dialog with **Cancel** as its only button; expect either rendering). The detour is expected, not a wrong turn — but both routes have real costs to disclose before they choose:

- **Azure free sign-up** — the generally available route. It requires a phone number and a non-prepaid credit or debit card; Microsoft may place a temporary $1 authorization and reverses it, and nothing is charged unless the person later moves to pay-as-you-go. (Verified 2026-08-08.)
- **The M365 Developer Program** is *not* generally available — its free E5 sandbox is for qualifying members (Visual Studio subscribers, partner-program companies); a personal account alone does not qualify. (Verified 2026-08-08.)

After the Azure sign-up completes (a few minutes), the blocking dialog can keep appearing: the witnessed clearing sequence is **Cancel** → back to **App registrations** → **+ New registration** again, not a page refresh. They return with the app's client ID — a GUID; Entra's Overview and the Console's Microsoft form both label it **Application (client) ID**.

**AGENT** — `POST /api/oauth/microsoft/app {"clientId": "..."}` — a clientId is not a secret, so this one you may drive without being asked; if the person prefers the Console, the card is **Sources** → **Add a source** → **Microsoft**. (Sending a clientSecret here is refused.) Then ask if ready → `GET /api/oauth/microsoft/start` → hand the URL over as plain text → they open and approve → verify with `GET /api/connectors`. One consent yields up to three connections, depending on what was granted. If the callback shows `{"error":"invalid or expired state"}` within seconds of a first use, the single-use URL was consumed before the click — almost always a link preview; mint a fresh one and keep it plain text.

### WHOOP

**AGENT** — `GET /api/oauth/whoop/app` → read `redirectUri`.

**HUMAN** — create the developer app in their own WHOOP account per https://docs.getpostern.com/connect/whoop, register that redirect URL. Two prompts to expect: WHOOP asks them to create a Team before the first app, and the create form wants a privacy-policy URL (any URL they control satisfies the form). They return with the client ID and client secret — pasted into the Console's WHOOP form; treat the secret as shown once.

**AGENT** — if asked to drive: `POST /api/oauth/whoop/app {"clientId": "...", "clientSecret": "..."}` → ask if ready → `GET /api/oauth/whoop/start` → plain-text URL → they open and approve → verify.

### Plaid — and how to talk about money sources

**Bring the choice to the person before naming a brand** — the first real user did not know what either name meant. Ask: *"Do you want to connect financial accounts — checking, savings, credit cards, loans, investments?"* Both routes are read-only; Postern can never move money or make a payment. Then compare in plain language (prices and plan terms verified 2026-08-08):

- **SimpleFIN** — one Bridge subscription, $1.50 + tax a month or $15.00 + tax a year, covers up to 25 institutions and 25 apps. No developer account. The simpler setup.
- **Plaid** — a developer account. New US/Canada teams (created on or after 2026-04-15) land on a free **Trial** plan: real bank data, a **lifetime** cap of 10 connected banks — deleting one does not give the slot back, and every Production access token created counts against it, so connect only accounts they mean to keep. Beyond the Trial, Plaid bills per connected bank. Use Plaid for institutions SimpleFIN cannot reach, or when the Trial suits.

Say "financial institution" rather than "bank" — credit cards, loans and investment accounts connect the same way.

**HUMAN** — a Plaid developer account at https://dashboard.plaid.com/signup (staying on Trial — no paid upgrade), and from its dashboard the client ID and the **Production** secret: left menu, under Platform: **Developers** → **Keys**. The secret is pasted into the Console — **Sources** → **Add a source** → **Plaid** → **Save & add a bank** — never into chat. The Console saves the app as Production; Plaid's Trial runs on real Production data, so this is correct for Trial accounts too. Then they sign in to each institution inside Plaid's own window; Postern never sees the bank sign-in. Guide: https://docs.getpostern.com/connect/plaid

**AGENT** — verify with `GET /api/connectors`; each institution becomes its own connection. Driving on request (only when the person explicitly asks — Never rule 3 governs the value afterwards):

```
POST /api/plaid/app           {"clientId": "...", "clientSecret": "...", "env": "production"}
POST /api/plaid/hosted-link   {}    → {"linkToken", "hostedLinkUrl"}
```

All three `plaid/app` fields are required, and only the literal string `production` leaves the sandbox (the API accepts exactly two values, `sandbox` and `production` — there is no third). Then ask: *"Ready to sign in to your banks?"* — only on yes give them `hostedLinkUrl` as plain text (Never rule 6 covers this window too), then:

```
POST /api/plaid/poll   {"linkToken": "..."}     → repeat until {"complete": true, "connections": [...]}
```

### Apple Health — the iPhone pushes

**Disclose the cost before a single step.** The iPhone app this path uses — **Health Auto Export - JSON+CSV** — puts automatic REST-API export behind its paid Premium tier: $1.99/month, $6.99/year, or $24.99 once; the free tier and the $2.99 Basic purchase do not include automations, and the app's own setup pages do not warn about this before the paywall appears. (Prices verified 2026-08-08.) That purchase decision is a **HUMAN** stop — and skipping Apple Health entirely affects nothing else; deferring it to last is a fine answer.

Prerequisite, human-led and outside this file: the phone must reach the gateway over the person's private Tailscale network — https://docs.getpostern.com/start/remote-access#your-devices. Two settings in Tailscale's admin console (MagicDNS and HTTPS certificates — https://docs.getpostern.com/start/remote-access#tailscale) must be on for their tailnet; this file has no verified agent path for either, so they are the person's steps. **Also check, before wiring anything: whether the tailnet HTTPS port is already in use** — `tailscale serve status` on the gateway machine. In the recorded setup, port 8443 was already proxying a different local app — and a later `serve` command replaces what is there, a collision this project has hit before. If the port is held, pick a different one for the ingest route rather than replace a working route.

**AGENT** — the credential's `secret` is a fixed sentinel — the Console sends the same one; the real gate is the webhook secret minted below. The secret value is the **entire line inside this fence, parenthetical included** — it is the Console's own constant, copied exactly:

```
device-push (no upstream credential — auth is the per-connection webhook secret)
```

```
POST /api/credentials                          {"provider": "apple_health", "secret": "<the sentinel above>"}
POST /api/connectors                           {"credentialId": "...", "sector": "health"}
POST /api/connectors/<connectionId>/webhook    {}    → 201 {"ingestUrl": "/api/ingest/<id>", "secret": "..."}
```

`ingestUrl` is a **relative path**: the address the phone posts to is the person's remote-access origin (for example `https://<machine>.<tailnet>.ts.net:8443`) + that path.

**HUMAN** — on the iPhone, in the Health Auto Export app (the first real user knew it only as "Auto Export" — hand over the full App Store name): two REST API automations — one exporting health metrics, one exporting workouts — both posting JSON to that address with header `Authorization: Bearer <the webhook secret>`. The guide has the field-by-field: https://docs.getpostern.com/connect/apple-health. Then run one export manually.

**AGENT** — watch `GET /api/connectors` until the health connection reports data arriving (it is a push source — `POST /sync` will not pull for it).

### After every source

```
POST /api/connectors/<connectionId>/sync
GET  /api/connectors
```

**Read the sync body, not the status code — once a run starts, the route answers HTTP 200 whatever the outcome.** (A revoked connection is refused with 409 before any run.) Three shapes:

- `"ok": true` with an `upserted` count — done.
- `"ok": false` with an `"error"` string — failed; the string is the gateway's sanitized cause.
- `"ran": true, "timed_out": true, "note": "sync still running"` — and **no `ok` key at all**: a big first sync outran the route's fixed 30-second wait and is still going in the background. Poll `GET /api/connectors/<connectionId>` — `freshness.state` reads `syncing` and `cached_count` climbs while it runs. **Never POST `/sync` again to "check"** — the route has no in-flight guard, and a second POST starts a second, concurrent pull against the provider.

(Push sources — home_assistant, apple_health — answer `"ran": false`, `"event-driven connector; no manual pull"` — or `"ok": false` with `"push stream down — reconnect the source"` when the stream is not up: their health is the stream state, not a pull.)

Each connection reports one freshness state: `ok | syncing | stale | unreachable | error | paused | disconnected | never_synced`. A row that sits at `never_synced` while looking otherwise healthy usually means a provider or sector string typo. The fix — disconnect it and redo with the exact string:

```
DELETE /api/connectors/<connectionId>    {"confirmToken": "<the same connectionId>"}
```

The body is required and the token must echo the connectionId verbatim — a fat-finger guard, not auth; without it the call is a 400 and nothing is deleted. (A DELETE carrying a JSON body is unusual — send it explicitly: `curl -X DELETE -H 'Content-Type: application/json' -d '{"confirmToken":"<id>"}' http://localhost:8787/api/connectors/<id>`.) The credential and its sealed secret are removed only when its **last** connection goes, so disconnecting one of Apple's three leaves the credential and the other two intact.

## Phase 3 — wire an agent in

Sources are connected; now give an agent a key. Open by drawing the line the first real user needed drawn: **connecting a source to Postern** and **authorizing an agent to read it** are different decisions. The first is about what flows *in*; this one is about who reads it — and it is not yours to default, because the data is the person's private life. That is why the consent below is a stop, not a formality.

**0. HUMAN — which client, and where is it?** Ask which agent gets the key — you (the agent running this setup), Claude Code, Cursor, OpenClaw, something else — and whether it runs on this machine. A client on another machine cannot use `localhost:8788`; reaching the agent port from other devices is its own human-led step: https://docs.getpostern.com/start/remote-access#your-devices. And before prescribing any tunnel to a client's own settings UI, ask whether the person can already open it from their device — an existing private network (Tailscale) often already serves it, and a redundant tunnel is noise. If their everyday client lives elsewhere, wire yourself in here first and prove the loop; hand them that page for the rest.

**1. HUMAN — the consent.** The six sectors that exist — exactly these strings: `finance` · `health` · `mail` · `contacts` · `calendar` · `home`. Offer the choice in three honest shapes:

- **Everything** — all six, including sectors with nothing connected yet; a source added later flows in without another grant. (`"*"` grants all six — that is theirs to say, never your default.)
- **What is connected today** — read the list off `GET /api/connectors` and name it.
- **A subset they name.**

Two facts that lower the stakes: grants are editable later without changing the key (the key's page in the Console, or `PATCH` below), and `home` is the one sector that includes *actions*, not just reads — say so if it is on the table.

**2. The key — minted by the person in the Console (the default path).** Keys are secrets; the person creating and placing their own key means it never exists in the chat at all. One batch, on the gateway machine's Console:

1. Left rail → **Agents & keys** → **Mint a key**.
2. **Name** — the client's name (`claude-code`, `openclaw`, …).
3. **Grant which sectors** — toggle exactly what was consented above.
4. **Expires** — the chips are **Never · 30 days · 60 days · 90 days**. Suggest 90 days; **Never** is theirs to choose, with one consequence stated: a never-expiring key cannot sign in to a hosted client (claude.ai, ChatGPT) — Postern's own bridge refuses it.
5. **Mint the key** → the reveal screen shows **Agent key — shown once**. They **Copy** it straight into the client's config or a password manager — **never into the chat**, and if they paste it into chat anyway, treat the key as exposed and have them rotate it.
6. The reveal screen also offers **Copy config · key included** — a ready-made MCP config block *with the plaintext key inside*. Same rule as the key itself: it goes into a config file only. It pastes as-is into Claude Code's `.mcp.json` or Cursor's `mcp.json`; it does **not** paste into OpenClaw — see "Put the key into the client" below.

**3. The key — minted by you (only when the person asks you to drive).**

   ```
   POST /api/agents
   {"agentId": "claude-code", "sectors": ["calendar", "contacts"], "expiresInDays": 90}
   ```

   → `201 {"agentId", "sectors", "key", "expires_at"}`. The key appears once and can never be re-read.
   - `expiresInDays` always (Never rule 7). Whole days, 1–3650.
   - Sector strings are not validated at mint. A typo returns 201, looks correct in the Console, and is silently dropped when the key is used — you would connect fine and be denied every read. Hence: **verify what was stored** with `GET /api/agents` — confirm `sectors` is exactly what the person granted. A typo needs no re-mint: `PATCH` the exact strings.
   - Later edits: `PATCH /api/agents/<agentId>` takes `{"sectors": [...]}` and/or `{"expiresInDays": 90}` (or `null` for never) — **same key, no rewiring**; live MCP sessions re-initialize, the config keeps working. An expiry edit is refused (400) on a revoked or already-expired grant — rotate then. A re-POST of the same `agentId` is a *rotate*: new key, old sessions killed, your config broken until rewritten — and a rotate that omits `expiresInDays` silently resets the key to never-expiring.

**4. Put the key into the client.** Who runs these follows from who holds the key: when the person minted it (the default), hand them the exact command or block with `<key>` left as the placeholder they fill in, and *they* run it — the key stays out of the chat. Run these yourself only when you minted the key in step 3. The agent endpoint is Streamable HTTP at `http://localhost:8788/mcp` (the port is `MCP_HTTP_PORT`, set by the shipped compose — substitute if moved), authenticated per request with `Authorization: Bearer <key>`. It is published loopback-only, like everything else here.
   - **Claude Code:** `claude mcp add --transport http postern http://localhost:8788/mcp --header "Authorization: Bearer <key>"` — the default scope is local to the directory you run it in. Ask the person where they will actually use you, and run it there (running it inside the install directory wires Postern to the one directory they will never work in).
   - **Cursor:** add to Cursor's `mcp.json` (its location varies by setup — the docs deliberately name no path; see https://docs.getpostern.com/start/connect-an-agent#paste-and-restart):
     `{"mcpServers": {"postern": {"type": "http", "url": "http://localhost:8788/mcp", "headers": {"Authorization": "Bearer <key>"}}}}`
   - **OpenClaw** (verified in a real setup, 2026-08-08): OpenClaw stores MCP servers under `mcp.servers` with `transport: "streamable-http"` — the Console's `mcpServers`/`type: "http"` block is **not** pasteable; the fields map one-to-one instead. UI path, from OpenClaw's own docs: **Control UI → Settings → MCP → Configured servers → Add server** — name `postern`, transport **Streamable HTTP**, URL `http://localhost:8788/mcp`; the Authorization header is added in the scoped config editor further down that page; then **Save & Publish**. Or the person runs the CLI form:
     `openclaw mcp set postern '{"url":"http://localhost:8788/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer <key>"},"enabled":true}'` then `openclaw mcp reload`.
     Verify with `openclaw mcp doctor postern --probe` (expect `postern: ok` — plus a warning that the Authorization header is a literal sensitive value: expected, OpenClaw has no secret-ref for bearer headers, and its config file is user-only `0600`) and `openclaw mcp probe postern` (expect `postern: <N> tools`).
   - **Any other client** (Codex and the rest): the same three facts — a streamable-HTTP MCP server, that URL, that header — in your client's own documented MCP config format. This file does not guess formats it has not verified.

**5. Prove one read — and prove where it landed.** A tool call that works does not prove it reached *this* gateway. ChatGPT/Codex accounts carry **account-level connectors** that travel with the signed-in account onto any machine, and a shared account shares them: in the first real setup, a client signed into a shared account used that account's own connector, its reads landed on a *different household's* gateway, and this gateway's ledger stayed empty throughout (the far half of that trace came from the other gateway's audit, relayed — the local half was verified directly). So: after the client's config reloads, have it make exactly one `describe_context` call, and confirm that call in this gateway's ledger — `GET /api/audit?agent=<agentId>`, or the key's page in the Console under **Recent passage** — before showing the person the result: the granted sectors, and the connections they just made, with freshness. The ledger records the agent name on every call; treat it as a lower bound (entries can drop under load), and a rotated key inherits its name's history. If calls succeed but this ledger stays empty: inventory the account-level connectors of the account the client is signed into, give local and cloud entries visibly different names, and remove or disable the one the person did not intend; separate people should use separate accounts. (The no-reload check `curl -H "Authorization: Bearer <key>" http://localhost:8787/api/context` exists, but it bypasses the client entirely and so proves nothing about the client's routing — use it only to test the key itself.)

## Phase 4 — prove it, and stop

This phase is strictly read-only. The complete list of calls you may make here: the MCP tools `describe_context`, `get_schema`, `query`, `get_record` — or their REST mirror `GET /api/context`, `GET /api/schema`, `POST /api/query`, `GET /api/records/<sector>/<id>` with your bearer — plus `GET /api/connectors`, `GET /api/agents`, and `GET /api/audit`. Nothing else.

1. `describe_context` — every connected sector present, freshness sensible.
2. One `query` per connected **object key**, as a count, not a data dump — the rows are the person's, not the terminal's. The keys are not always the sector name: `mail` · `contacts` · `calendar` · `home` are bare, but finance and health need the full dotted key — `finance.account` · `finance.transaction` · `finance.holding` · `health.sample` · `health.workout` · `health.sleep_session`. Read the exact keys off `get_schema` rather than assuming. A complete example:

   ```
   POST /api/query          Authorization: Bearer <key>
   {"sector": "finance.transaction", "aggregate": {"fn": "count"}}
   ```

   The answer is `groups[0].value`. In aggregate mode the top-level `count` is the number of *groups* — with no `groupBy` it is always `1` — never report it as the total. (On a plain row read, `count` is the page size: 100 by default, 500 at most.)
3. If finance is connected, tell the person while showing the count: amounts are signed and negative means money out — spending is `amount < 0`, and a naive sum nets income against spending.
4. `GET /api/audit` — show them your own reads from a moment ago, already logged. That ledger is their record of everything you, and every future agent, do here. (Honestly: it is a lower bound — the log is fire-and-forget and can drop entries under load — and it records agent *names*, so a rotated key inherits its predecessor's history.)
5. Report: what is connected, what is fresh, when the key expires (`expires_at`), and that the Console can revoke it — or `PATCH` its deadline or grants — at any time.

## When something is wrong

| symptom | likely cause | fix |
|---|---|---|
| `Cannot connect to the Docker daemon` | engine installed but not running | Docker Desktop: the person starts it. colima: `brew services start colima` — and on first boot, wait out the VM download (Phase 0) |
| compose refuses: `set POSTGRES_PASSWORD in .env` | no `.env` | Phase 1, step 2 |
| `docker compose up` fails: `port is already allocated` | 8787 or 8788 held by something else | set `REST_PORT` / `MCP_HTTP_PORT` in `.env`, re-run |
| app restarts; db healthy; auth errors in its logs | `.env` password changed after first boot | restore the original password if it can be found; only if it cannot, the gated recovery in Phase 0 — read its gate in full first |
| `/healthz` stays `unavailable` | database container down or unhealthy | `docker compose logs db` |
| every admin call returns `403 {"error":"forbidden host"}` | you are reaching the gateway through a proxy that rewrites the Host header | the admin surface is not reachable that way — use the same machine or `ssh -L`; do **not** widen `REST_ALLOWED_HOSTS` |
| provider shows a redirect-URI mismatch | the registered URI is not the literal from `GET /api/oauth/<provider>/app` — did the port move? | re-read it, re-register it, retry |
| consent approved, then the browser lands on "can't reach this page" at `localhost:<port>` | their browser is not on the gateway's machine, so the fixed callback address points at nothing on their computer | set up the `ssh -L` forward from the end of Phase 1, leave it running, then mint a fresh authorization URL (`GET /api/oauth/<provider>/start`) |
| callback shows `{"error":"invalid or expired state"}` seconds after the URL was minted | the single-use URL was consumed before the person clicked — usually a chat client's link preview prefetching it | mint a fresh authorization URL (`GET /api/oauth/<provider>/start`; for Plaid, a fresh `POST /api/plaid/hosted-link`) and hand it over as plain text in a code block, never a clickable link |
| consent approved but the callback failed | the 10-minute window expired, or the gateway restarted mid-consent | mint a fresh authorization URL with `GET /api/oauth/<provider>/start` and try again |
| iCloud syncs fail — `apple: DAV connect failed`, `apple: DAV account discovery failed`, or `icloud-mail: sync failed` — while the credential reads `active` | iCloud did not accept the app-specific password; the gateway masks Apple's detail, and `active` only means a secret is stored | the person redoes the Console form (with a fresh app-specific password if in any doubt the first was copied whole) — the reconnect replaces the secret in place |
| `/sync` returns `"timed_out": true, "note": "sync still running"` | a big first sync outran the 30-second HTTP wait; it is still running | poll `GET /api/connectors/<connectionId>` until `freshness.state` leaves `syncing`; never re-POST `/sync` — it starts a second concurrent pull |
| Home Assistant `unreachable`, `stream_state` `"down"`, zero records — while cloud sources stay green | the engine's VM cannot reach the LAN. With colima on macOS, check the **Local Network** privacy permission first — allowing it fixed the recorded setup immediately, and a prior outage in this project was attributed to macOS silently re-denying it after an upgrade replaced the binary. Colima's own tracked cause for the same symptom is a second default route in the VM | the person, in the Mac's GUI: **System Settings → Privacy & Security → Local Network** → allow the VM's entry. Probe: `colima ssh -- curl http://<lan-ip>:8123/api/` — any HTTP code (401 is normal) means fixed; still `000`/exit 7 → check `colima ssh -- ip route` for a second default route. Do not touch the VM's network config |
| your key connects but every read is denied | sector typo at mint — the grant intersected to nothing | `GET /api/agents`, then `PATCH /api/agents/<agentId> {"sectors": [<the exact strings>]}` — same key, no re-mint |
| a cloud client refuses the key at sign-in | the key never expires | `PATCH /api/agents/<agentId> {"expiresInDays": 90}` — same key, no rewiring. If the PATCH is refused (grant revoked or already expired), re-POST — and then rewrite the key in the MCP config and re-verify, because a re-POST mints a new key |
| the client's calls succeed but this gateway's audit shows nothing under the agentId | the client used an **account-level cloud connector** (ChatGPT/Codex account), not the local MCP entry — shared accounts share connectors | Phase 3 step 5: inventory both layers, distinct names, remove or disable the unintended one, re-verify via the ledger |
| a connection exists but never syncs, no error | provider string typo (`homeassistant`, a trailing space…) | `DELETE /api/connectors/<id>` with body `{"confirmToken": "<the same id>"}`, then redo with the exact registry string |
| refused, and none of the above explains it | — | https://docs.getpostern.com/reference/refusals |

## What this file will not help you do

- **Publish the gateway to the internet** (needed only for hosted clients like claude.ai and ChatGPT). The API would accept the consent field from you — see Never rule 5 for why you still must not send it. Publishing is the person's decision, made in the Console (Settings → Remote access) with https://docs.getpostern.com/start/remote-access#publish beside them.
- **Claude Desktop.** Supported in principle through a stdio bridge, but no verified recipe exists yet; the docs say so, and this file will not invent one: https://docs.getpostern.com/reference/mcp-primitives#claude-desktop
- **Anything on a provider's screens.** Where a provider's screen disagrees with a guide, the screen is right — ask the person to report it: https://github.com/getpostern/postern/issues
