# Admin Panel - Architecture (Version a jour)

Frontend admin
-> Firebase Auth (ID token)
-> Backend API (authorization + business rules)
-> Firestore via backend pour mutations critiques

Regle centrale:
- Autorisation admin et logique metier critiques: backend uniquement
- `localStorage` reserve a l UX de session
