# Destro VanityGuard

```
██████╗ ███████╗███████╗████████╗██████╗  ██████╗
██╔══██╗██╔════╝██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗
██║  ██║█████╗  ███████╗   ██║   ██████╔╝██║   ██║
██║  ██║██╔══╝  ╚════██║   ██║   ██╔══██╗██║   ██║
██████╔╝███████╗███████║   ██║   ██║  ██║╚██████╔╝
╚═════╝ ╚══════╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝
```

**v2.0.0 — by Darky | destro engine**

A fast Discord vanity URL protector written in JavaScript (Node.js).

---

## Features

- Ultra-fast vanity URL restoration via TurboPool (raw TLS connections)
- TOTP/MFA support with NTP time sync
- Parallel session pool for concurrent requests
- Gateway WebSocket with auto-reconnect
- Streaming status presence
- File logging support

---

## Requirements

- Node.js **v18+**

---

## Setup

```bash
# 1. Clone / download the project
# 2. Install dependencies
npm install

# 3. Copy config
cp config.example.json config.json

# 4. Edit config.json with your token
nano config.json

# 5. Run
npm start
```

---

## Configuration

```json
{
  "vanity_guard": {
    "enabled": true,
    "user_token": "YOUR_USER_TOKEN_HERE",
    "mfa_secret": "YOUR_MFA_SECRET_HERE",
    "guild_ids": []
  }
}
```

| Field        | Description                                      |
|--------------|--------------------------------------------------|
| `user_token` | Your Discord user token                          |
| `mfa_secret` | Your TOTP MFA secret (base32). Leave default if not used. |
| `guild_ids`  | Specific guild IDs to monitor. Leave `[]` for all guilds. |

---

## CLI Options

```
node index.js [options]

  --config <path>   Path to config.json
  --token  <token>  Override user token
  --mfa    <secret> Override MFA secret
  --log    <path>   Log file path
```


---

## Disclaimer

⚠️ **Selfbot Usage Warning**

This project operates using a **Discord user account (selfbot)**.  
Selfbots are strictly **against Discord's Terms of Service**.

By using this tool, you acknowledge that:

- Your account may be **flagged, limited, or permanently terminated** by Discord.
- This tool is provided **for educational purposes only**.
- You are using it **entirely at your own risk**.

❗ The developers of Destro VanityGuard (**Darky**) are **not responsible** for:
- Account bans or terminations
- Loss of access to your Discord account
- Any misuse of this software

Use responsibly.


---

## Usage Notice

You are allowed to use this source code for your own projects or modifications.

However, you **must not forget to give proper credit** to the original developer (**Darky**) as stated in the Attribution Policy.

Failure to provide credit is a violation of the terms.

---

## Credits

- **Author:** Darky
- **Engine:** destro

---

## Attribution Policy

> **If you use, fork, redistribute, or build upon Destro VanityGuard — you MUST give full credit to the original developer.**

### Rules

- You **must** keep the original author name **Darky** visible in your README, source headers, and any public release.
- You **must not** remove, hide, or replace the `Credits: Darky` comments from any source file.
- You **must not** claim this project as your own or present it as original work without crediting **Darky**.
- You **must not** sell or monetize this tool without explicit written permission from **Darky**.
- If you modify and redistribute this project, your README **must** clearly state:
  > *"Based on Destro VanityGuard, originally developed by Darky."*
- Any Discord server, bot listing, or public post showcasing this tool **must** credit **Darky** as the original author.

### How to Credit (Example)

```
Destro VanityGuard — Originally developed by Darky
https://github.com/your-repo

Credits: Darky (destro engine)
```

Failure to credit the original developer is a violation of the terms of use.
Respect the work. Credit the creator.

---

## License

This project is provided for educational and personal use only.
All rights reserved by **Darky**. Redistribution without credit is strictly prohibited.
