# Security Specification — RelayTag Firestore Rules

## 1. Data Invariants
1. **Master Gate & Relational Sync**: A `RelayMessage` in `/tags/{tagCode}/messages/{messageId}` cannot be created unless the parent `/tags/{tagCode}` document exists and currently has `contactEnabled == true`. Reading (`get` and `list`) messages in Firestore is strictly restricted to the verified authorized owner (`isAuthorizedOwner() && existing().ownerId == request.auth.uid`).
2. **Authorized Owner Lock & Identity Integrity**: A `VehicleTag` can only be listed, created, updated, or deleted by the verified authorized owner (`request.auth.token.email_verified == true && request.auth.token.email == 'yuwon6881@gmail.com'`) whose `request.auth.uid` strictly matches `ownerId`.
3. **PII Isolation (Split Collection Strategy) & Capability Vaults**: Email addresses and raw Telegram Bot tokens live exclusively inside `/users/{userId}/private/{configId}` and can only be read or written by the verified authorized owner (`isAuthorizedOwner() && request.auth.uid == userId`). Server recovery vaults at `/tags/{tagCode}/vault/{vaultId}` are non-listable (`allow list: if false`), require an exact 36-character server-HMAC capability ID (`^vlt_[a-f0-9]{32}$`), and store only AES-256-GCM ciphertext encrypted with server-side secret entropy.
4. **Temporal & Immutable Field Integrity**: `createdAt` must equal `request.time` on creation and remain immutable on update; `updatedAt` must equal `request.time` on every update. `ownerId` and `code` are immutable after creation.

## 2. The "Dirty Dozen" Payloads
1. **Shadow Field Injection on Tag Create**: Adding `"isAdmin": true` to `/tags/RT-482-9XK`.
2. **Identity Spoofing on Tag Create**: Authenticated user `uid_attacker` sets `"ownerId": "uid_victim"`.
3. **Unverified or Unauthorized Email Write**: Authenticated user with `email_verified: false` or `email != 'yuwon6881@gmail.com'` attempts to create or modify a `VehicleTag`.
4. **Oversized String ("Denial of Wallet")**: Setting `statusNote` to a 5,000-character string (exceeds `maxLength: 160`).
5. **Path Poisoning ID**: Creating a document with an invalid ID containing spaces or special characters, or a vault ID not matching `^vlt_[a-f0-9]{32}$`.
6. **Immutable Field Mutation**: Updating `ownerId` or `createdAt` on an existing `/tags/{tagCode}` document.
7. **Forged Client Timestamp**: Supplying a past or future timestamp instead of `request.time` for `createdAt` or `updatedAt`.
8. **Cross-User PII or Message Read**: Unauthenticated caller or non-owner attempts `get` on `/users/uid_victim/private/config` or `/tags/RT-482-9XK/messages/msg1`.
9. **Blanket List Scraping on Tags**: Querying `/tags` without `isAuthorizedOwner()` and filtering `resource.data.ownerId == request.auth.uid`.
10. **Orphaned Message Write**: Creating `/tags/NON_EXISTENT/messages/msg1` when parent tag does not exist.
11. **Locked Tag Message Bypass**: Creating a message in `/tags/{tagCode}/messages/{messageId}` when parent tag has `contactEnabled == false`.
12. **Value Poisoning on Update**: Updating `contactEnabled` with a string `"yes"` instead of a boolean.
