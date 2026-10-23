# Security Specification — RelayTag Firestore Rules

## 1. Data Invariants
1. **Master Gate & Relational Sync**: A `RelayMessage` in `/tags/{tagCode}/messages/{messageId}` cannot be created unless the parent `/tags/{tagCode}` document exists and currently has `contactEnabled == true`.
2. **Identity Integrity**: A `VehicleTag` can only be created, updated, or deleted by a verified user (`request.auth.token.email_verified == true`) whose `request.auth.uid` strictly matches `ownerId`.
3. **PII Isolation (Split Collection Strategy)**: Email addresses and Telegram Bot tokens live exclusively inside `/users/{userId}/private/{configId}` and can only be read or written by the verified owner (`request.auth.uid == userId`).
4. **Temporal & Immutable Field Integrity**: `createdAt` must equal `request.time` on creation and remain immutable on update; `updatedAt` must equal `request.time` on every update. `ownerId` and `code` are immutable after creation.

## 2. The "Dirty Dozen" Payloads
1. **Shadow Field Injection on Tag Create**: Adding `"isAdmin": true` to `/tags/RT-482-9XK`.
2. **Identity Spoofing on Tag Create**: Authenticated user `uid_attacker` sets `"ownerId": "uid_victim"`.
3. **Unverified Email Write**: Authenticated user with `email_verified: false` attempts to create a `VehicleTag`.
4. **Oversized String ("Denial of Wallet")**: Setting `statusNote` to a 5,000-character string (exceeds `maxLength: 160`).
5. **Path Poisoning ID**: Creating a document with an invalid ID containing spaces or special characters.
6. **Immutable Field Mutation**: Updating `ownerId` or `createdAt` on an existing `/tags/{tagCode}` document.
7. **Forged Client Timestamp**: Supplying a past or future timestamp instead of `request.time` for `createdAt` or `updatedAt`.
8. **Cross-User PII Read**: Authenticated user `uid_attacker` attempts `get` on `/users/uid_victim/private/config`.
9. **Blanket List Scraping on Tags**: Querying `/tags` without filtering `resource.data.ownerId == request.auth.uid`.
10. **Orphaned Message Write**: Creating `/tags/NON_EXISTENT/messages/msg1` when parent tag does not exist.
11. **Locked Tag Message Bypass**: Creating a message in `/tags/{tagCode}/messages/{messageId}` when parent tag has `contactEnabled == false`.
12. **Value Poisoning on Update**: Updating `contactEnabled` with a string `"yes"` instead of a boolean.
