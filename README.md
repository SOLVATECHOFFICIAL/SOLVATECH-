# SOLVATECH BOT

SOLVATECH BOT is a WhatsApp Multi-Device bot for SOLVATECHOFFICIAL. It uses Baileys pairing codes, file-backed authentication, a sequential message queue, and JSON group settings.

## Message behavior

- The linked WhatsApp account is the account that sends bot responses.
- Only messages sent by that linked WhatsApp account can run dot commands. Other people are ignored for commands.
- Commands from the linked account are answered in the same private chat or group where they were sent. Group responses are therefore visible to all group members.
- Text command responses are sent without quoting the incoming command, so `.menu`, `.vv`, `.anti`, and similar command text is not echoed inside the bot's response.
- Every command gets an immediate same-chat typing presence and temporary `⏳ Processing…` message that is deleted immediately after the response is sent. Processing is queued per chat, so a slow video/audio download cannot hold up other groups.
- `.sticker` converts replied images or videos into stickers, and `.vv` recovers supported view-once media.
- `.vv` recovers quoted view-once images, videos, voice notes/audio, documents, and stickers when WhatsApp still provides the encrypted media.
- Group admins can enable two protections: anti-link and anti-bot. Each one deletes the trigger where possible and removes the offending non-admin member when the bot is a group admin.

## Run on Replit

1. Open the pairing console at the app URL.
2. Enter the WhatsApp number with country code, without a leading `+` or spaces.
3. Select **Get Pairing Code**.
4. On WhatsApp, open **Linked Devices → Link a device → Link with phone number**, then enter the displayed code.
5. Keep the app running while WhatsApp completes the link. The server automatically handles WhatsApp's expected `515 restartRequired` reconnect after a successful pairing.

The service listens on `PORT` (default `8000`) and exposes:

- `GET /bot-api/status`
- `POST /bot-api/pair` with `{ "number": "234712345678" }`
- `POST /bot-api/disconnect`

## Local run

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:8000`.

## Deploy to Railway

Upload this folder to a Railway project or deploy the included ZIP. Railway
will detect `railway.json`, install the dependencies, start `npm run serve`,
and check `/bot-api/status`.

Attach a persistent Railway volume mounted at `/app/runtime` and set
`BOT_DATA_DIR=/app/runtime` so the linked WhatsApp account, group settings,
and logs survive restarts.

## Deploy to Render

Use Node.js 20+ and the following commands:

- Build: `npm install`
- Start: `npm run serve`

The included `render.yaml` configures Node 20, `npm start`, a health check, and
a 1 GB persistent disk mounted at `/opt/render/project/src/runtime`. Without
persistent storage, the WhatsApp link will be lost when the service restarts.

## Deploy with Docker or another Node host

This repository includes a `Dockerfile` and `Procfile`:

```bash
docker build -t solvatech-bot .
docker run -p 8000:8000 -v solvatech-runtime:/app/runtime solvatech-bot
```

For any Node.js host, use Node 20+, run `npm install` during the build, and run
`npm start` as the service command. Set `PORT` from the host and point
`BOT_DATA_DIR` at a persistent volume. The health endpoint is
`GET /bot-api/status`.

On Replit, run `npm run dev` and open the generated web URL. On Railway or Render,
set `PORT` from the platform environment. Keep `BOT_DATA_DIR` pointed at the
persistent disk. Do not commit the contents of the runtime directory; the
included `.gitignore` keeps authentication files out of GitHub.

If WhatsApp says it could not link the device, request a fresh code and enter it immediately.
Use the full international number with digits only (for Nigeria, `234` followed by the
number without its leading `0`). The pairing connection waits for WhatsApp's ready signal
and uses the canonical Chrome companion label required by the pairing protocol.

## Commands

The bot exposes these commands:

`.alive` `.ping` `.menu` `.groupinfo` `.add` `.kick` `.promote` `.demote` `.tagall` `.tagadmin` `.lock` `.unlock` `.anti` `.antilink` `.antibot` `.sticker` `.vv`

Use `.anti` without arguments to see protection status. The dedicated switches are:

- `.antilink on/off`
- `.antibot on/off`

`.anti <link|bot> on/off` is also supported. `.admins` and `.tagadmins` are not registered; `.tagadmin` is the single admin-mention command.

`.vv` tries Baileys media download, a direct media URL, and a media-key download path in that order.