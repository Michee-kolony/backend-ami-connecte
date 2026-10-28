# Relance communautaire du RECO

Mise en œuvre du cahier « Mécanisme de fonctionnement de l'application de relance communautaire du
RECO » (v1.0, 27 octobre 2026). Le module détecte les personnes à relancer (CPN, accouchement,
postnatal, vaccination), crée des tâches attribuées au relais communautaire (RECO) du quartier, suit
le contact, la visite et l'orientation, et ne compte la réintégration qu'après confirmation de la
prestation par la structure. Il assiste les équipes : il ne pose aucun diagnostic et ne modifie aucun
dossier clinique.

## Ce qui reste à valider avant la mise en production (section 16)

Rien ne se déclenche tant que ces éléments ne sont pas saisis et validés dans **Relance communautaire → Paramétrage** :

- définitions officielles, critères d'entrée et de sortie, formule d'indicateur de **RAC, ARC, RPC, IRC et TCC**
  (fiches créées vides, statut « À valider ») ;
- rattachement de chaque règle à un parcours, délais de tolérance, priorités, nombre de tentatives, délais
  d'escalade (valeurs proposées par défaut, règles **inactives**) ;
- textes des SMS / WhatsApp (`messageNeutre`, `config/relance.js`), horaires de contact, durées de conservation,
  hébergement et sauvegardes : à faire valider par le programme.

## Rôles

| Rôle | Ce qu'il voit et fait |
|---|---|
| RECO (jeton `typ: reco`, espace `/reco`) | Ses tâches seulement ; contact, visite, orientation, refus / report, demande d'appui, urgence, signalement. Pas de domaine clinique (CPN, vaccination…) : un motif neutre. Téléphone visible seulement si un canal téléphonique est consenti. |
| Superviseur communautaire (infirmier·ère ou sage-femme titulaire / superviseur·e) | Tâches nominatives de sa structure : attribution, réattribution (motif obligatoire), escalade, clôture motivée, réouverture, contrôle qualité, arbitrage des conflits, comptes RECO, tableau de bord. |
| Responsable de structure / zone (médecin chef de service, médecin directeur) | Comme le superviseur, plus le **paramétrage** (parcours et règles, versions, validation). Sans structure choisie à la connexion : toutes les structures. |
| Prestataire (autres soignants) | Seulement les personnes **orientées** vers sa structure, pour confirmer la prestation. Pas de tableau de bord. |

Un jeton RECO est refusé sur les routes du personnel, et inversement. Les refus sont journalisés.

## Données (MongoDB)

- `recos` (`RECO-0001`) — structure de rattachement, aire de santé, **zones** (quartiers couverts), superviseur,
  `sessionsRevoqueesLe` (téléphone perdu : tous les jetons antérieurs sont refusés).
- `relance_parcours` — fiche RAC / ARC / RPC / IRC / TCC, versionnée (`historique`), statut `À valider | Validé | Suspendu`.
- `relance_regles` — déclencheur versionné : `CPN_RDV_MANQUE`, `ACC_ISSUE_INCONNUE`, `PN_VISITE_NON_DOCUMENTEE`,
  `VAC_DOSE_NON_DOCUMENTEE` ; statut `Inactive | Active | Suspendue`.
- `relance_taches` (`REL-000001`) — champs minimums de la section 8 ; motifs reliés, actions (jamais écrasées),
  visites, orientation, confirmation, résolution, contrôles, conflits, historique de chaque changement de statut.
  **Index unique partiel** sur `cle` (parcours + personne) pour les tâches ouvertes : une seule tâche active.
- `relance_alertes` — alertes regroupées par type et destinataire, accusé de réception obligatoire.

## Moteur (`config/moteurRelance.js`)

Toutes les 30 minutes (`RELANCE_INTERVALLE_MIN`), et à la demande (bouton « Lancer la détection ») :

1. **Confirmation** — une tâche ouverte dont la prestation est enregistrée par un soignant (consultation
   finalisée, admission ou issue de grossesse, visite de l'enfant, dose de vaccin) passe en
   « Réintégration confirmée », avec la référence et l'auteur de la prestation.
2. **Détection** — chaque règle active, en vigueur et rattachée à un parcours validé :
   - CPN : rendez-vous passé au-delà de la tolérance, sans consultation depuis la veille du rendez-vous ;
   - accouchement : DPA retenue dépassée, sans issue ni dossier d'accouchement ;
   - postnatal : nouveau-né sans visite de suivi ni consultation postnatale de la mère ;
   - vaccination : dose « à faire / en retard » au-delà de la tolérance ; enfant **zéro-dose** en priorité.
3. **Dédoublonnage** — un motif déjà traité (clé règle + objet) ne crée jamais de seconde relance ; un nouveau
   motif d'une personne qui a déjà une tâche ouverte dans le même parcours est **relié** à cette tâche.
4. **Attribution** — RECO actif de la structure dont les zones couvrent le quartier (sinon même aire de santé),
   le moins chargé. Sans RECO : tâche « Nouvelle » et alerte au superviseur.
5. **Alertes** — échéance proche (RECO), retard, urgence non prise en charge, échecs répétés, demande d'appui,
   urgence, signalement, conflit (superviseur), orientation non confirmée (structure). Une seule fois par tâche.

## Application RECO (`/api/reco`, écran `/reco` d'ami-sante)

- `POST /connexion` `{ matricule, motDePasse }` → jeton 12 h (`JWT_RECO_EXPIRES_IN`).
- `GET /taches`, `GET /referentiel`, `GET /alertes`, `POST /alertes/:id/accuser`.
- `POST /taches/:numero/actions` et `POST /synchroniser` `{ operations: [...] }` — chaque action porte un
  `operationId` unique créé sur le téléphone : renvoyée deux fois, elle n'est appliquée qu'une fois. Les actions
  sont appliquées dans l'ordre où elles ont été faites. Une action reçue sur une tâche clôturée, réattribuée ou
  en supervision est **conservée en conflit** sans modifier la tâche (une confirmation clinique n'est jamais écrasée).
- `POST /signalements` — situation à vérifier ; part au superviseur (« Escaladée »), qui la rattache au dossier.

Sur le téléphone : tâches et actions en attente gardées dans IndexedDB, **chiffrées en AES-GCM** (clé non
exportable générée sur l'appareil) quand le navigateur le permet ; nombre d'actions en attente et date de
dernière synchronisation affichés ; verrouillage après 5 minutes d'inactivité (déverrouillage sans réseau par
empreinte PBKDF2 du mot de passe) ; déconnexion = suppression de la base locale et de la clé.

Règles d'action : canal téléphonique refusé sans consentement (`Patiente.consentements`) ; orientation seulement
après un contact établi ; « Non retrouvée » automatiquement après le nombre maximal de tentatives ; une urgence
escalade immédiatement (le RECO ne la gère jamais seul).

## Personnel (`/api/relance`)

`GET /taches`, `GET /taches/:numero`, `POST /taches/:numero/{attribuer|confirmer|cloturer|rouvrir|escalader|controler|identifier}`,
`POST /taches/:numero/conflits/:id/resoudre`, `GET /alertes`, `POST /alertes/:id/accuser`, `POST /detection`,
`GET /tableau-de-bord`, comptes `GET|POST /recos`, `PATCH /recos/:id`, `PATCH /recos/:id/statut`,
`POST /recos/:id/{mot-de-passe|revoquer-sessions}`, paramétrage `GET /parametrage`,
`PUT /parametrage/{parcours|regles}/:code`, `POST /parametrage/parcours/:code/{valider|suspendre}`,
`POST /parametrage/regles/:code/{activer|suspendre}`.

Une réintégration confirmée ne peut pas être rouverte. Une clôture d'une tâche encore chez le RECO est
marquée **exceptionnelle**. Toute action est inscrite dans l'historique de la tâche et dans le journal d'audit.

## Indicateurs (`GET /tableau-de-bord`)

Cohorte = tâches créées dans la période (90 jours par défaut), hors doublons. Chaque indicateur renvoie
numérateur, dénominateur et formule. Taux « personnes » = personnes uniques ; taux « tâches » = tâches.

| Indicateur | Formule |
|---|---|
| Taux de contact | personnes contactées ÷ personnes confiées au RECO |
| Taux de visites réalisées | visites réalisées ÷ visites planifiées arrivées à échéance |
| Taux de réintégration | personnes dont la reprise est **confirmée** ÷ personnes éligibles |
| Taux de tâches résolues | tâches échues clôturées avec un résultat valide ÷ tâches échues |
| Taux de tâches en retard | tâches ouvertes à échéance dépassée ÷ tâches ouvertes |
| Délai moyen de résolution | moyenne (clôture − création) des tâches résolues, en jours |
| Taux de non-retrouvés | personnes « non retrouvée » ÷ personnes ayant fait l'objet d'une tentative |

Ces indicateurs transversaux sont des exemples techniques ; ils sont calculés **séparément pour chaque parcours**.
Le tableau de bord présente aussi la charge (par statut, RECO, aire), le continuum mère-enfant par domaine, la qualité
des données, la traçabilité (réattributions, clôtures exceptionnelles, actions hors ligne, conflits, synchronisations)
et une désagrégation par âge et aire de santé où les effectifs **inférieurs à 5 sont masqués**.

## Tests

`tests/relance.test.js` (MongoDB en mémoire, données fictives) reprend les critères d'acceptation de la section 15 :
tâche unique, prestation existante sans relance, visibilité par rôle et territoire, historique complet, orientation
non comptée comme réintégration, retard et escalade, indicateurs sans double comptage, synchronisation sans doublon
avec conflits, journalisation, message neutre.
