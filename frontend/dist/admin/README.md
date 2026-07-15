# Admin Panel - README (Version a jour)

Ce dossier contient le front admin Actuarus.

## Source de verite securite
- Authentification: Firebase Auth (ID token)
- Autorisation admin: backend uniquement via `GET /api/auth/me` + middleware `requireAdmin`
- Actions sensibles: endpoints backend admin, jamais en ecriture Firestore directe depuis le navigateur

## Flux runtime
1. Connexion sur `login.html`
2. Verification backend admin (`/api/auth/me`)
3. Navigation admin (`index.html`, `deals.html`, `disputes.html`, `users.html`, `settings.html`)
4. Operations critiques via API backend:
   - `POST /api/admin/transactions/:id/resolve-dispute`
   - `POST /api/admin/users/:id/suspend`
   - `POST /api/admin/users/:id/reactivate`
   - `PUT /api/app-settings` (admin uniquement)

## Notes importantes
- `localStorage` ne sert qu'a l'UX de session, pas a l'autorisation.
- Ne pas reintroduire de whitelist email cote frontend.
- Ne pas reintroduire d'ecritures Firestore admin directes cote frontend.
