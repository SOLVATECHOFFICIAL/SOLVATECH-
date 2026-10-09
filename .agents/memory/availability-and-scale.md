---
name: Availability and scale expectations
description: User-stated uptime, concurrency, and command-response expectations for this WhatsApp bot.
---

The user expects the bot to serve about 5,000 simultaneous users, remain online 24/7 until a license expires, and respond to commands quickly.

**Why:** The user stated these as core requirements for the product.

**How to apply:** Treat latency and availability as primary requirements. Measure real throughput and deployment resources before claiming the target is met; do not add intentional serialization to command handling without demonstrating that it is needed.
