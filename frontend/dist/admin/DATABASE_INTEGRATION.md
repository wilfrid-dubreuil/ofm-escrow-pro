# Admin Panel - Database Integration (Version a jour)

## Principe
Le frontend admin lit les donnees et appelle des endpoints backend securises.

## Interdits
- Ecriture admin sensible Firestore directe depuis le frontend
- Validation role admin par `localStorage`

## Autorise
- Verification role via `/api/auth/me`
- Mutations critiques via endpoints backend admin

## Endpoints cibles
- `POST /api/admin/transactions/:id/resolve-dispute`
- `POST /api/admin/users/:id/suspend`
- `POST /api/admin/users/:id/reactivate`
- `PUT /api/app-settings`
