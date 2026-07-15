# Admin Panel - API Reference (Version a jour)

## Auth
- `GET /api/auth/me` -> identite et role admin

## Admin actions
- `POST /api/admin/transactions/:id/resolve-dispute`
- `POST /api/admin/users/:id/suspend`
- `POST /api/admin/users/:id/reactivate`
- `PUT /api/app-settings`

## Important
Le frontend ne decide jamais des privileges admin.
Le backend est l autorite unique (`requireAdmin`).
