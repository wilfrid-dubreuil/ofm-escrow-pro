# Admin Panel - Test Suite (Version a jour)

## Tests critiques
1. Login admin via `login.html`
2. `/api/auth/me` retourne `isAdmin: true`
3. Resolution litige via endpoint backend admin
4. Suspend/reactivate utilisateur via endpoints backend admin
5. Save settings via `PUT /api/app-settings` avec Bearer token

## Anti-regression
- Aucun test base sur `localStorage` pour autoriser un admin
- Aucun test qui valide un write Firestore admin direct depuis frontend
