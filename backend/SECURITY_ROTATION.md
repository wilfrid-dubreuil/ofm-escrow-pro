# Rotation et suppression des secrets

Ce document couvre la phase suivante de remédiation sécurité:
- suppression des secrets versionnés,
- rotation des secrets compromis,
- remise en service avec secrets locaux non versionnés.

## 1) Ce qui a été supprimé du repo

- `backend/midgen-u6gv0i-firebase-adminsdk-fbsvc-ae88ed43bb.json` a été retiré.
- Le backend ne lit plus de chemin hardcodé pour le service account.
- Le backend lit `GOOGLE_APPLICATION_CREDENTIALS` (standard Admin SDK) ou `FIREBASE_SERVICE_ACCOUNT_PATH`.

## 2) Rotation immédiate (Firebase Service Account)

1. Ouvrir Google Cloud Console (projet Firebase concerné).
2. Aller dans IAM & Admin > Service Accounts.
3. Trouver le compte `firebase-adminsdk-*` utilisé par l'application.
4. Créer une nouvelle clé JSON.
5. Révoquer/supprimer l'ancienne clé (celle potentiellement exposée).
6. Copier la nouvelle clé en local uniquement, par exemple:
   - `backend/secrets/firebase-adminsdk.json`
7. Ne jamais committer ce fichier.

## 3) Configuration locale

Dans `backend/.env`:

```env
GOOGLE_APPLICATION_CREDENTIALS=./secrets/firebase-adminsdk.json
# ou, pour compatibilite projet:
FIREBASE_SERVICE_ACCOUNT_PATH=./secrets/firebase-adminsdk.json
FIREBASE_STORAGE_BUCKET=midgen-u6gv0i.firebasestorage.app
```

Un modèle sans secret est fourni:
- `backend/secrets/firebase-adminsdk.example.json`

## 4) Certificats TLS locaux

Les certificats locaux sous `backend/certs/*.pem` ne doivent pas être versionnés.
Si vous suspectez une exposition locale:

1. Supprimer les `.pem` existants.
2. Redémarrer le backend: des certificats auto-signés seront régénérés.

## 5) Hygiène Git (important)

La suppression actuelle retire le secret de l'état courant, mais pas de l'historique Git.
Pour purge complète de l'historique, exécuter une réécriture d'historique (équipe + CI coordonnée), par exemple avec `git filter-repo`.

### Plan exécutable (git filter-repo)

Pré-requis:
- Python via `py -3`
- package `git-filter-repo` installé (`py -3 -m pip install --user git-filter-repo`)

Exécution recommandée dans un clone miroir (pour ne pas toucher le working tree actif):

```powershell
$repo = "c:\ofm-escrow-pro"
$mirror = "$env:TEMP\ofm-escrow-pro-history-purge.git"
Remove-Item -Recurse -Force $mirror -ErrorAction SilentlyContinue
git clone --mirror $repo $mirror

git -C $mirror filter-repo \
   --path backend/midgen-u6gv0i-firebase-adminsdk-fbsvc-ae88ed43bb.json \
   --invert-paths \
   --force

# Vérification purge
git -C $mirror log --all -- backend/midgen-u6gv0i-firebase-adminsdk-fbsvc-ae88ed43bb.json
git -C $mirror rev-list --objects --all | Select-String -SimpleMatch "backend/midgen-u6gv0i-firebase-adminsdk-fbsvc-ae88ed43bb.json"

# Préflight push
git -C $mirror remote add origin https://github.com/wilfrid-dubreuil/ofm-escrow-pro.git
git -C $mirror push --force --mirror --dry-run origin

# Publication réelle
git -C $mirror push --force --mirror origin
```

Script prêt à l'emploi:
- `scripts/purge-secret-history.ps1`

Ce script exécute: clone miroir -> purge -> vérifications -> dry-run push.

## 6) Vérification

- Démarrer le backend et vérifier l'initialisation Firebase Admin.
- Vérifier que `git status` n'affiche plus de secret JSON suivi.
- Vérifier que le backend fonctionne sans fallback de secret embarqué.

## 7) Check CI après force-push

Constat dans ce dépôt:
- Aucun workflow GitHub Actions versionné localement (`.github/workflows` absent).

Checklist CI/CD à exécuter après `push --force --mirror`:
1. Vérifier la dernière exécution CI sur la branche `main` (provider externe éventuel: GitHub, Cloud Build, etc.).
2. Vérifier les environnements de déploiement (staging/prod) avec un build complet.
3. Vérifier les protections de branche (si activées) et réautoriser temporairement l'historique réécrit si nécessaire.
4. Refaire un scan de secrets sur l'historique distant après push.

Commande de contrôle post-push (dans un clone frais):

```powershell
git clone https://github.com/wilfrid-dubreuil/ofm-escrow-pro.git ofm-escrow-pro-fresh
git -C ofm-escrow-pro-fresh log --all -- backend/midgen-u6gv0i-firebase-adminsdk-fbsvc-ae88ed43bb.json
git -C ofm-escrow-pro-fresh rev-list --objects --all | Select-String -SimpleMatch "backend/midgen-u6gv0i-firebase-adminsdk-fbsvc-ae88ed43bb.json"
```
