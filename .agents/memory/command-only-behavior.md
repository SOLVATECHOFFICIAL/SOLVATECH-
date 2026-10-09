---
name: Command-only behavior
description: User-stated scope for command handling and automatic replies in WhatsApp chats.
---

The bot should handle explicit commands in private chats and groups. Ordinary non-command chat should not trigger automatic conversational AI replies. Preserve group moderation features and existing per-command access restrictions.

**Why:** The user clarified that this is the intended behavior.

**How to apply:** Keep command dispatch available in both private and group chats, retain owner-only checks on sensitive commands, and do not add unsolicited AI replies to normal messages.
