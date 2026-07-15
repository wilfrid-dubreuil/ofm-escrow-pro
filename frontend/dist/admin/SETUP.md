# Admin Panel - Setup (Version a jour)

## Prerequis
- Backend Express demarre
- Firebase Auth actif
- Compte admin configure cote serveur

## Verification rapide
1. Ouvrir `https://localhost:3001/admin/login.html`
2. Se connecter
3. Verifier que `/api/auth/me` retourne `isAdmin: true`

## Regles d implementation
- Aucun controle role admin en frontend par email hardcode
- Aucune operation admin sensible en ecriture Firestore directe cote navigateur
- Toute mutation critique passe par endpoint backend protege

## Endpoints admin a utiliser
- `POST /api/admin/transactions/:id/resolve-dispute`
- `POST /api/admin/users/:id/suspend`
- `POST /api/admin/users/:id/reactivate`
- `PUT /api/app-settings`

## Depannage
- Acces refuse: verifier token Bearer + config admin serveur
- Action admin echoue: verifier middleware `requireAdmin` et logs backend
