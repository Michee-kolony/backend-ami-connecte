# Suivi prénatal (CPN) — espace administrateur

Mise en œuvre du cahier des charges « Parcours prénatal, dossier partagé et traçabilité » (v1.0),
côté serveur et tableau de bord. L'application mobile patiente viendra dans une phase suivante.

## Règles d'accès (appliquées par l'API)

| Rôle | Dossier médical, consultations, rendez-vous | Journal global |
|---|---|---|
| Médecin, Médecin directeur | Toutes les patientes ; chaque ouverture est journalisée | Non |
| Médecin chef de service | Idem | Oui (`/api/journal`) |
| Infirmier·ère (tous rôles) | Lecture seule : recherche (sans indicateur de risque), `GET /api/patientes/:id/suivi` (grossesse en cours, rendez-vous) et agenda. **403** journalisé sur tout le reste (dossier complet, consultations, antécédents, risques, carte, modifications) | Non |
| Compte suspendu | **401** à la requête suivante, même avec un ancien jeton | — |

`middleware/clinique.js` (`exigerMedecin`) protège toutes les routes cliniques ;
l'auteur d'un acte vient toujours de la session (`req.soignant`), jamais du corps de la requête.

## Données (MongoDB)

- `patientes` — identité, contact, consentements, résidence, antécédents. Identifiant public `AC-PAT-000001`.
- `grossesses` — datation (méthode, date de référence, AG de référence, DPA calculée/retenue, médecin validant),
  historique des datations remplacées, facteurs de risque relevés, issue de grossesse.
- `consultations` — un document par visite : auteur figé, type, constantes, examen, traitements, prochain RDV,
  statut `Brouillon → Finalisée` (verrouillée) ou `Annulée` (motif). Corrections = addenda. Aucune suppression.
- `rendezvous` — statut `Planifié/Confirmé/Reporté/Effectué/Annulé/Absent`, historique de chaque changement.
- `journal_audit` — ajout seul (modifications/suppressions refusées par le modèle), sans contenu clinique.

## API

| Méthode et route | Fonction |
|---|---|
| `GET /api/patientes?q=&statut=&page=&parPage=` | Recherche paginée (max 50), résultats minimisés (téléphone masqué) |
| `GET /api/patientes/doublons?nom=&prenom=&dateNaissance=&telephone=` | Dossiers possiblement identiques |
| `POST /api/patientes` | Enregistrement multipart : `donnees` (JSON) + `photo` obligatoire ; e-mail et mot de passe de la patiente obligatoires (409 + `doublons` tant que `confirmerMalgreDoublons` n'est pas vrai) |
| `GET /api/patientes/:id` | Dossier complet (`AC-PAT-…` ou id) — journalisé `dossier.lecture` |
| `PATCH /api/patientes/:id` | Informations administratives (champs modifiés journalisés, sans valeurs) |
| `DELETE /api/patientes/:id` | Médecin chef : suppression définitive (`confirmation` = numéro du dossier) ; le journal d'audit est conservé |
| `GET /api/patientes/:id/journal` | Historique d'audit du dossier |
| `POST /api/patientes/:id/grossesses` | Nouvelle grossesse (si aucune en cours) |
| `GET/POST /api/patientes/:id/rendez-vous` | Rendez-vous de la patiente (1 RDV attendu par jour) |
| `PATCH /api/grossesses/:id` | Facteurs de risque, grossesse multiple |
| `PUT /api/grossesses/:id/datation` | Nouvelle datation (motif obligatoire si elle en remplace une) |
| `POST /api/grossesses/:id/issue` | Issue de grossesse → dossier en suivi postnatal |
| `GET/POST /api/grossesses/:id/consultations` | Liste / nouvelle consultation (`finaliser: true` possible) |
| `GET/PATCH /api/consultations/:id` | Lecture (journalisée) / brouillon modifié par son auteur |
| `POST /api/consultations/:id/finaliser` | Verrouillage, AG figé, RDV du jour → Effectué, prochain RDV créé |
| `POST /api/consultations/:id/addenda` | Correction signée (texte + motif) |
| `POST /api/consultations/:id/annuler` | Annulation avec motif |
| `GET /api/rendez-vous?du=&au=` | Agenda |
| `PATCH /api/rendez-vous/:id` | `confirmer`, `reporter` (date + motif), `effectue`, `absent`, `annuler` (motif) |
| `GET /api/journal?page=&resultat=refusé` | Journal global (médecin chef) |
| `GET /api/statistiques/patientes` | Indicateurs du tableau de bord (totaux, inscriptions par semaine, trimestres, 26 provinces, dossiers récents, prochains RDV, qualité) ; nombre de grossesses à risque pour les médecins seulement |

## Photo et compte de la patiente

- **Photo** : obligatoire à l'enregistrement, stockée dans R2 sous `patiente/` (clé aléatoire). Seule la clé est en base ;
  l'API renvoie un lien **signé valable 15 minutes** (`photoUrl`), jamais l'adresse publique.
  Recommandé en production : un bucket R2 **sans accès public** dédié aux données des patientes.
- **Compte** : e-mail (unique, obligatoire, non effaçable) et mot de passe saisis par la patiente
  (8 caractères, lettres et chiffres), haché avec bcrypt, jamais renvoyé. `espaceEnLigne` passe à « Activé ».
  La connexion de l'application mobile sera ajoutée avec l'espace patiente.

## Tests

```bash
npm test
```

Base MongoDB **en mémoire** (`mongodb-memory-server`) et données fictives : aucune donnée réelle n'est lue ni
écrite. Les tests couvrent notamment AC-01, AC-04 à AC-09, AC-13 à AC-15 du cahier des charges.

## Choix à faire valider (responsable médical / juridique)

- **Enregistrement réservé aux médecins.** Le cahier des charges interdit aux infirmier·ères la recherche et la
  lecture du dossier ; sans recherche, le contrôle des doublons est impossible : l'enregistrement est donc
  réservé aux médecins. Une évolution pourrait autoriser un enregistrement administratif minimal.
- Liste des facteurs de risque proposés, examens proposés, repères d'attention (TA ≥ 140/90, T ≥ 38 °C,
  BCF hors 110–160) : indicatifs, à aligner sur le protocole national RDC.
- Calcul DPA : par DDR, règle de Naegele selon le mois de la DDR (janvier à mars : mois + 9 ; avril à décembre : mois − 3 et année + 1), puis jour + 7 ;
  par échographie ou examen clinique, référence + 280 j − AG ; correction > 7 jours exigeant une justification.
- Le médecin chef (rôle de gestion des comptes) a aussi accès au dossier, puisqu'il est médecin.

## Non couvert par cette phase

Activation et espace patiente (application mobile), envoi effectif des rappels (SMS/WhatsApp),
résultats d'examens structurés, documents privés R2, limitation des tentatives de connexion.

## Discussions entre soignants (temps réel)

Messagerie privée 1-à-1 entre médecins et infirmier·ères (`/admin/discussions` dans le tableau de bord).

| Méthode et route | Fonction |
|---|---|
| `GET /api/discussions` | Mes discussions : interlocuteur, dernier message, non lus |
| `GET /api/discussions/annuaire` | Soignants actifs à qui écrire |
| `POST /api/discussions` | Ouvre (ou retrouve) la discussion avec `soignantId` |
| `GET /api/discussions/:id/messages?avant=` | Historique paginé (50 messages) |
| `POST /api/discussions/:id/messages` | Envoi (`texte`, 2 000 caractères max) |
| `POST /api/discussions/:id/lu` | Accusé de lecture |

Événements socket.io (même connexion que la présence) : `discussion:message`, `discussion:lu`,
`discussion:ecrit` (« en train d'écrire »).

**Sécurité**
- Seuls les deux participants peuvent lire, écrire ou recevoir les événements (vérifié à chaque requête
  et à chaque événement ; une discussion d'autrui répond 404, sans révéler son existence).
- Texte **chiffré au repos** (AES-256-GCM, IV aléatoire par message, intégrité vérifiée).
  Clé : `CHAT_CLE` (32 octets en base64). À défaut, clé dérivée de `JWT_SECRET` — à éviter en production.
- Contenu des messages jamais écrit dans les journaux du serveur.
- 30 messages par minute et par soignant au maximum ; compte suspendu : accès et connexion temps réel coupés.
- Non couvert : chiffrement de bout en bout (le serveur peut déchiffrer pour remettre les messages),
  pièces jointes. En production, HTTPS/WSS obligatoire.
