# Security Specification — Mark-XXX (J.A.R.V.I.S. — Mark LVII)

## 1. Data Invariants
1. Every document in `/users/{userId}` and its subcollections (`messages`, `memories`, `tasks`, `routines`, `monitors`) is strictly private to the authenticated owner (`request.auth.uid == userId` and `data.uid == request.auth.uid`).
2. Users cannot create, read, list, update, or delete another user's profile, communications log, memories, background tasks, routines, or monitors.
3. Subcollection writes require the parent `/users/{userId}` document to exist (`exists(...)`), preventing orphaned subcollection records.
4. `uid` and `createdAt` are immutable on update; `createdAt` and `updatedAt` must equal `request.time`.
5. Terminal `BackgroundTask` statuses (`done`, `failed`, `cancelled`) are locked against further state modification.
6. Every string field enforces strict `.size()` bounds and enum constraints; IDs match `^[a-zA-Z0-9_\-]+$` (<= 128 chars).
7. Every array (`steps`) is strictly bounded (`<= 20` items) and validates element types when non-empty.

## 2. "Dirty Dozen" Adversarial Payloads
1. **Cross-User Profile Read**: User B attempts `get /users/userA` -> `PERMISSION_DENIED`.
2. **Identity Spoofing on Create**: User A writes `/users/userA/memories/m1` with `uid: "userB"` -> `PERMISSION_DENIED`.
3. **Shadow Field Injection**: User A writes `/users/userA` with extra field `isAdmin: true` -> `PERMISSION_DENIED` (`hasOnly` check).
4. **Unverified Email Write**: User with `email_verified: false` attempts write -> `PERMISSION_DENIED`.
5. **ID Poisoning**: User attempts write to `/users/userA/tasks/<1500-char-junk>` -> `PERMISSION_DENIED` (`isValidId`).
6. **Client Timestamp Forgery**: User submits `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time` -> `PERMISSION_DENIED`.
7. **Immutable Field Mutation**: User attempts update on `/users/userA/memories/m1` changing `createdAt` or `uid` -> `PERMISSION_DENIED`.
8. **Terminal State Unlock**: User attempts to update a `BackgroundTask` whose `status` is `"done"` -> `PERMISSION_DENIED`.
9. **Value Type Poisoning**: User updates `accentColor` to `"not-a-hex"` or boolean -> `PERMISSION_DENIED`.
10. **Oversized Payload (Denial of Wallet)**: User writes `text` of 50,000 chars in `messages` -> `PERMISSION_DENIED`.
11. **Unbounded Array Injection**: User writes `steps` with 50 items in `tasks` -> `PERMISSION_DENIED`.
12. **Orphaned Subcollection Write**: User writes `/users/userA/routines/r1` before `/users/userA` exists -> `PERMISSION_DENIED`.
