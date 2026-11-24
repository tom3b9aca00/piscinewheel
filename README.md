# 🎡 Roue des Coalitions

Une roue à tourner pour distribuer des points entre 3 coalitions représentées par des dinosaures — T-rex (vert), tricératops (bleu) et stégosaure (rouge) — … ou des TIG.

- **Connexion simple** : on tape son login (n'importe lequel, sans mot de passe) — la vraie connexion 42 Next est prête mais désactivée, voir plus bas
- **Scores partagés** : tout le monde voit le même tableau, mis à jour toutes les 5 s
- Le **tirage** et l'**attente de 30 s** sont faits par le serveur : impossible de tricher depuis le navigateur

## La roue

35 cases :
- 30 cases coalition : `-50`, `-25`, `0`, `+25`, `+50` × 3 coalitions × 2
- 4 cases TIG (1 TIG chacune), placées comme une boussole (N / E / S / O) — **1 chance sur 10** au total
- 1 case **42**, visible (taille de 2 cases) mais impossible à obtenir

Les cases coalition sont mélangées à chaque chargement, jamais deux cases de la même coalition ni de la même valeur côte à côte. La roue ralentit fortement à la fin, dépasse un peu et recule sur la case finale (~11 s). Après un tirage, chaque personne attend **30 secondes** avant de relancer.

## Lancer en local

Prérequis : **Node.js 20.12+** (aucun `npm install`, aucune configuration nécessaire).

```sh
npm start
```

Ouvre <http://localhost:3000>, tape un login et tourne la roue. Pour essayer à plusieurs
sur le même ordinateur, utilise une fenêtre de navigation privée par personne.

⚠️ En mode simple, chacun peut se connecter sous n'importe quel login : l'attente de 30 s
peut donc être contournée en changeant de login, et il n'y a pas d'admin
(pour remettre les scores à zéro : arrête le serveur et supprime `data/state.json`).

## Activer la vraie connexion 42 Next (plus tard)

42 Next se connecte via **Keycloak** (realm `42Next` sur `keycloak.prod.42.tech`, OpenID Connect).
Il faut **demander au staff / à l'équipe 42 Next un client OpenID Connect** :

- flux **Authorization Code** (+ PKCE S256)
- *Valid redirect URIs* : `http://localhost:3000/callback` (et plus tard `https://ton-domaine/callback`)
- *Scopes* : `openid profile email`

Puis `cp .env.example .env`, mets `AUTH_PROVIDER=42next`, remplis `FT_CLIENT_ID`
(et `FT_CLIENT_SECRET` si fourni), éventuellement `ALLOWED_EMAIL_DOMAINS` pour n'accepter
que les e-mails de 42 Marseille, et ton login dans `ADMINS`. Redémarre avec `npm start`.

> Ancienne intra : `AUTH_PROVIDER=intra` (application créée sur profile.intra.42.fr,
> campus vérifié avec `ALLOWED_CAMPUS`).

En local, les scores sont stockés dans `data/state.json` (supprime ce fichier, serveur arrêté, pour tout remettre à zéro). En ligne, ils sont dans Upstash.

⚠️ Ne publie jamais `.env` (il contient le secret 42) — il est dans `.gitignore`.

## Fichiers

| Fichier | Rôle |
|---|---|
| `server.js` | Serveur : connexion 42, vérification du campus, tirage, scores, attente |
| `config.js` | Règles (valeurs, nombre de cases, chance de TIG, attente) — partagé serveur / page |
| `public/index.html` | La roue (dessin, dinosaures, animation, confettis) |
| `public/login.html` | Page de connexion |
| `render.yaml` | Configuration de l'hébergement Render |
| `.env` | Facultatif : réglages et identifiants 42 Next (à créer depuis `.env.example`) |

## Mettre en ligne (GitHub + Render, gratuit)

1. **Scores permanents — Upstash** : crée un compte sur <https://upstash.com>, puis
   *Create Database* (Redis, région Europe, offre gratuite). Dans l'onglet **REST API**,
   copie **UPSTASH_REDIS_REST_URL** et **UPSTASH_REDIS_REST_TOKEN**.
   > Sans ça, les scores sont effacés à chaque mise en veille de Render (après 15 min sans visite).
2. **Render** : crée un compte sur <https://render.com> avec ton compte GitHub, puis
   **New + → Blueprint**, choisis ce dépôt : Render lit `render.yaml` et crée le service.
   Il te demande les deux valeurs Upstash : colle-les.
3. Attends le déploiement (~1 min) : la roue est en ligne sur `https://roue-coalition-xxxx.onrender.com`.
   Chaque `git push` redéploie automatiquement.

Offre gratuite Render : le serveur s'endort après 15 min sans visite, la première visite
suivante prend ~30–50 s le temps qu'il se réveille. Les scores (dans Upstash) ne sont pas perdus.

⚠️ En mode simple, n'importe qui peut se connecter sous n'importe quel login. Quand tu auras
un client 42 Next, ajoute dans Render (*Environment*) `AUTH_PROVIDER=42next`, `FT_CLIENT_ID`,
`FT_CLIENT_SECRET`, `FT_REDIRECT_URI=https://ton-adresse.onrender.com/callback` et `ADMINS`.
