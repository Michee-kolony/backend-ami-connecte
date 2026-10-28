# Mode hors connexion

Mise en œuvre du cahier « AMI Santé Connect — Spécifications du mode hors connexion ». L'espace
administrateur (PWA Angular) s'ouvre sans réseau, enregistre les saisies dans une base locale chiffrée
et les envoie au retour du réseau. Ce document décrit ce que le **serveur** garantit ; le dossier
technique complet (diagnostic, architecture, recette OFF-01 à OFF-12, guide, procédures) est livré à part.

## Ce qui reste à valider avant la mise en production

- durée de verrouillage (10 min) et durée maximale sans contact serveur (7 jours) : `VERROUILLAGE_MS` et
  `HORS_LIGNE_MAX_MS` dans `ami-sante/src/app/admin/data/session.service.ts` ;
- périmètre et durée de conservation des données copiées sur les appareils ;
- affectation des appareils aux structures, exigences nationales de protection des données de santé ;
- tests sur les appareils cibles et pilote sur un site.

## En-têtes envoyés par l'appareil

| En-tête | Rôle côté serveur |
|---|---|
| `X-Operation-Id` | Clé d'idempotence (`middleware/idempotence.js`, 8 à 80 caractères `[A-Za-z0-9_-]`). |
| `X-Version-Base` | Date de dernière modification du dossier lu par l'appareil (PATCH/PUT) : contrôle de conflit. |
| `X-Appareil`, `X-Saisie-Le` | Journal d'audit : identifiant aléatoire de l'appareil et date de saisie, sans donnée médicale. |

## Idempotence

Une écriture qui porte un `X-Operation-Id` déjà traité avec succès reçoit la **réponse enregistrée**
(en-tête `X-Operation-Rejouee: oui`), sans refaire l'action. Les réponses sont gardées 60 jours
(`models/OperationTraitee.js`, index TTL). Une opération en échec est oubliée (nouvel essai possible) ;
une opération reçue pendant son propre traitement reçoit 409. Les droits sont revérifiés à chaque rejeu.

## Conflits (`config/conflits.js`)

`verifierVersion(req, doc, libelle)` compare `X-Version-Base` à `doc.updatedAt` (tolérance 1 s). Si le
dossier a changé depuis : **409** `{ conflit: true, modifieLe, modifiePar }`, rien n'est écrit, la
saisie reste sur l'appareil pour une décision humaine. Appliqué à la modification d'une patiente, d'un
enfant, d'un rendez-vous, d'un brouillon de consultation et de l'admission en salle de travail. Les
ajouts (consultation, surveillance, dose, rendez-vous) ne sont jamais en conflit. Pour appliquer quand
même, l'appareil renvoie la saisie sans `X-Version-Base` (action tracée).

## Création hors connexion d'une patiente

`POST /api/patientes` renvoie `{ id, numero, grossesseId, consultationId }` : l'appareil remplace ses
identifiants locaux (`local-<uuid>`) par ceux du serveur. Avec `premiereConsultation`, le brouillon de la
première CPN est créé dans la même requête (une seule opération à rejouer).

## Appareil perdu, compte désactivé

- `POST /api/soignants/:id/revoquer-sessions` (médecin chef) : `sessionsRevoqueesLe` = maintenant ; tout
  jeton émis avant est refusé par `middleware/auth.js` avec **401** `{ revoque: true }`, et le soignant est
  expulsé du temps réel. Au premier contact, l'appareil efface sa base chiffrée et sa clé. Action
  journalisée (`soignant.revocation`).
- Compte suspendu ou supprimé : 401 `{ revoque: true }` également.
- Jeton expiré : 401 sans `revoque` (l'appareil garde sa file et demande une reconnexion).

## Tests

`tests/hors-ligne.test.js` : identifiants renvoyés à la création, rejeu (3 envois → 1 consultation),
conflits patiente et rendez-vous, droits au rejeu (403), révocation et jeton expiré, métadonnées du journal.
