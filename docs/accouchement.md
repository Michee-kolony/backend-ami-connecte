# Accouchement, nouveau-né et suivi de l'enfant

Mise en œuvre de la fiche « Module accouchement » (modules 1 à 6) et du suivi de l'enfant jusqu'à
l'âge préscolaire, avec le calendrier vaccinal du PEV de la RDC. Le bébé a son propre dossier,
rattaché au compte de sa mère : elle voit dans son espace son carnet, ses vaccins et ses rendez-vous.

## Règles d'accès

| Rôle | Dossier d'accouchement (`/api/accouchements`) | Dossier de l'enfant (`/api/enfants`) |
|---|---|---|
| Médecins | Tout | Tout |
| Sages-femmes | Tout | Tout |
| Infirmier·ères | **403** journalisé | Lecture, vaccinations, suivis, rendez-vous ; pas les données de naissance |
| Patiente (jeton `typ: patiente`) | **403** | **403** — lecture via `/api/espace-patiente` uniquement |

Un jeton patiente est refusé sur toutes les routes du personnel, et un jeton soignant sur l'espace patiente.
Les rôles autorisés en maternité sont dans `ROLES_MATERNITE` (`models/Soignant.js`).

## Données (MongoDB)

- `accouchements` (`AC-ACC-000001`) — un par grossesse : admission (identité + anamnèse, pré-remplies
  depuis la patiente et sa grossesse), examen clinique d'entrée, surveillances du travail (ajout seul),
  alertes, accouchement et délivrance, post-partum (surveillances, traitements, sortie, mesures préventives), clôture.
- `enfants` (`AC-ENF-000001`) — `mereId` (compte de la mère), naissance (SENN, cordon, mise au sein, mensurations,
  APGAR 1/5/10 min avec total calculé, réanimation, traitement), doses administrées (jamais effacées : annulées avec motif),
  visites de suivi (croissance, alimentation, développement).
- `rendezvous` — champ `enfantId` : les rendez-vous du bébé sont au nom de la mère (donc dans son espace) et
  marqués pour l'enfant. Un rendez-vous attendu par jour **par personne** (la mère et son bébé peuvent venir le même jour).

Référentiels : `config/accouchement.js` (listes de la fiche), `config/partogramme.js` (seuils et alertes),
`config/vaccination.js` (calendrier). Le tableau de bord les charge via `/api/referentiels/accouchement` et `/api/referentiels/vaccination`.

## Parcours

1. **Admission** `POST /api/accouchements` `{ patienteId, admission }` — patiente déjà enregistrée. Sans grossesse en cours
   dans la plateforme (arrivée directement en travail), une grossesse non datée est ouverte.
   Femme venue accoucher sans dossier (pas de CPN) : multipart, `donnees` en JSON `{ nouvellePatiente, compte, admission }`
   + `photo` de la patiente, **obligatoire** (400 sinon), comme à l'enregistrement CPN.
2. **Examen clinique** `PUT /:id/examen-clinique` — physique (6 systèmes), gynéco-obstétrical (TV, poche des eaux, engagement, bassin),
   labo d'entrée, conclusion / pronostic / CAT. Examinateur = soignant connecté.
3. **Surveillance du travail** `POST /:id/surveillances` — une ligne du tableau (latence ou phase active, mêmes champs).
   La phase active démarre à la première dilatation ≥ 4 cm. Chaque ligne renvoie `tempsDepuis` (arrivée, rupture, début du travail).
4. **Accouchement** `PUT /:id/accouchement` — type, gestes, délivrance (hémorragie pathologique calculée au-delà de 500 ml).
   La grossesse passe « Terminée » (issue et mode reportés), la patiente en « Suivi postnatal ».
   Les nouveau-nés sont ajoutés un par un par `POST /:id/nouveau-nes` (multipart : `donnees` en JSON + `photo`).
   La **photo est obligatoire pour un bébé né vivant** (identification, évite les confusions entre bébés) ;
   elle peut être remplacée par `PUT /api/enfants/:id/photo` (médecins et sages-femmes).
5. **Post-partum** `POST /:id/post-partum/surveillances` (`creneau` : `H1-15`… `H3-60`, `H4`–`H6`, `J1`–`J3` ou `Supplémentaire`) ;
   le dossier renvoie `planningPostPartum` (heure prévue et statut de chaque créneau). Traitements : `POST /:id/post-partum/traitements`,
   puis `.../:traitementId/administrer`.
6. **Sortie** `PUT /:id/sortie` — date, RDV CPoN (créé dans l'agenda de la mère), observations, conseils, mesures préventives (oui/non).
7. **Clôture** `POST /:id/cloturer` — refusée (400 + `manquants`) tant que l'accouchement, les nouveau-nés, la sortie et **toutes**
   les mesures préventives ne sont pas renseignés. « BCG / VPO » coché : BCG et VPO 0 sont reportés au carnet de chaque enfant.

8. **Suppression** `DELETE /:id` `{ confirmation: "AC-ACC-…" }` — **médecins seulement** (sages-femmes : 403 journalisé).
   Supprime définitivement le dossier, les dossiers des nouveau-nés qu'il a créés (carnet, vaccinations, croissance)
   et leurs rendez-vous, ainsi que le RDV CPoN. La grossesse qu'il avait close est rouverte (sauf si une autre est
   déjà en cours) et la patiente repasse en « Suivi prénatal ». Le journal d'audit est conservé (`accouchement.suppression`).

## Partogramme et alertes

- Graphe BCF : échelle 100–180, lignes 120 et 160. Graphe dilatation : ligne d'alerte (4 cm → 10 cm à 1 cm/h),
  ligne d'action 4 h à droite ; zone **verte** à gauche de la ligne d'alerte, **jaune** entre les deux, **rouge** au-delà.
  `GET /:id/partogramme` renvoie les points, les lignes et la zone de chaque point.
- Tableau sous la dilatation (`partogramme.tableau.colonnes`) : une colonne par heure de phase active (14 au minimum,
  colonne 1 = 0 à 1 h) avec contractions /10 min, durée, membranes, LA, pertes de sang, température, pouls, TA,
  diurèse, ocytocine (U/ml, gttes/min) — dernière valeur saisie dans l'heure — et tous les médicaments / injections IV de l'heure.
- Alertes calculées à chaque saisie (renvoyées dans la réponse, `sonore: true` pour celles qui doivent sonner) :

| Code | Déclencheur | Sonore | Notification |
|---|---|---|---|
| `BCF` | BCF < 120 ou > 160 | Oui | — |
| `Zone jaune` | la courbe franchit la ligne d'alerte | Non | — |
| `Stagnation` | dilatation sans progrès depuis ≥ 2 h en zone jaune (une fois par épisode) | Oui | — |
| `Zone rouge` | la courbe franchit la ligne d'action | Oui | Événement socket `accouchement:alerte` aux médecins de l'établissement (à défaut, tous les médecins actifs) |

- `GET /api/accouchements/alertes` : alertes non prises en charge ; `POST /:id/alertes/:alerteId/acquitter` (soignant et heure conservés).
- Les alertes sont évaluées **à la saisie** : sans nouvelle ligne, aucune alerte de stagnation n'est émise.

## Vaccination de l'enfant (PEV RDC)

| Séance | Doses |
|---|---|
| Naissance | BCG (jusqu'à 1 an), VPO 0 (dans les 14 jours) |
| 6 semaines | DTC-HepB-Hib 1, VPO 1, Pneumo 1 (PCV13), Rota 1 |
| 10 semaines | DTC-HepB-Hib 2, VPO 2, Pneumo 2, Rota 2 |
| 14 semaines | DTC-HepB-Hib 3, VPO 3, Pneumo 3, Rota 3, VPI 1 |
| 9 mois | VAR 1 (rougeole), VAA (fièvre jaune), VPI 2 |
| 15 mois | VAR 2 |
| 6 à 54 mois | Vitamine A tous les 6 mois ; mébendazole tous les 6 mois dès 12 mois |

- Statut de chaque dose : `Faite`, `À venir`, `À faire` (jusqu'à 14 jours après la date prévue), `En retard`, `Hors délai` (âge limite dépassé).
  Dans une série, une dose est prévue au moins 28 jours après la précédente (rattrapage).
- **Rendez-vous automatiques** : à la naissance puis après chaque vaccination, la prochaine séance est programmée (9 h, heure de Kinshasa)
  s'il n'y a pas déjà un rendez-vous attendu pour l'enfant ; les rendez-vous du jour passent « Effectué » à la saisie des doses.
- `POST /api/enfants/:id/vaccinations` `{ code, date?, lot, site, lieu }` ou `{ doses: [...] }` ; annulation : `.../:vaccinationId/annuler` `{ motif }`.
- `GET /api/enfants?retard=true` : enfants ayant au moins une dose en retard (relance PEV).
- Le calendrier est une liste dans `config/vaccination.js` : l'équipe PEV l'ajuste si le calendrier national évolue.

### Enfant né hors plateforme (ni CPN ni accouchement ici)

`POST /api/enfants` — tout le personnel soignant (la vaccination est souvent faite par les infirmier·ères). Multipart :
`donnees` en JSON, `photo` de l'enfant (**obligatoire**), `photoMere` (obligatoire pour une nouvelle mère).

```json
{
  "enfant": { "prenom": "", "nom": "", "sexe": "Féminin", "dateNaissance": "AAAA-MM-JJ", "heureNaissance": "HH:MM",
              "lieuNaissance": "", "naissance": { "poidsG": 3100, "tailleCm": null, "perimetreCranienCm": null } },
  "mereId": "AC-PAT-…",
  "nouvelleMere": { "nom": "", "prenom": "", "ageDeclare": 29, "email": "", "telephone": "" }, "compte": { "motDePasse": "" },
  "vaccinationsAnterieures": [{ "code": "bcg", "date": "AAAA-MM-JJ", "lieu": "" }],
  "confirmerMalgreDoublons": false
}
```

- `mereId` (dossier existant) **ou** `nouvelleMere` + `compte` : dossier minimal `enregistreeVia: "Enregistrement enfant"`,
  statut « Suivi postnatal », compte de l'application patiente activé. Doublons de la mère : 409 `doublons` (comme l'admission directe).
- Enfant `origine: "Né hors plateforme"`, sans `accouchementId` ; 6 ans au plus. Même mère, même date de naissance (et même prénom) : 409 `enfantExistant`.
- Doses déjà reçues recopiées du carnet papier : `reportee: true`, date obligatoire. Les doses manquantes ressortent « En retard »
  et la prochaine séance (rattrapage) est programmée tout de suite.

## Espace patiente (`/api/espace-patiente`)

| Route | Contenu |
|---|---|
| `POST /connexion` `{ email, motDePasse }` | Jeton patiente (`JWT_PATIENTE_EXPIRES_IN`, 30 jours par défaut) |
| `GET /moi`, `PUT /moi/mot-de-passe` | Profil, changement de mot de passe |
| `GET /accueil` | Grossesse en cours, prochains rendez-vous (mère et bébés), prochaine séance de vaccination de chaque enfant |
| `GET /rendez-vous` | Tous ses rendez-vous, ceux des enfants marqués `enfant: { id, prenom }` |
| `GET /enfants`, `GET /enfants/:id` | Carnet vaccinal, croissance, mensurations et APGAR de naissance, rendez-vous (404 pour l'enfant d'une autre) |
| `GET /accouchements` | Date, type, enfants, sortie, RDV CPoN, conseils, mesures préventives reçues (pas de partogramme) |

Chaque lecture est journalisée (`espace.lecture`), avec la patiente comme actrice.

## Reprise du suivi prénatal à l'ouverture du dossier

`controllers/suiviPrenatal.js` lit les consultations **finalisées** et la dernière échographie de la grossesse :

- **Admission** (copiée à l'admission, puis proposée pour les champs restés vides) : identité, groupe/rhésus, statut Hb, G/P/A/EV, DDR/DPA, statut VIH (DCIP, résultat annoncé, TAR), antécédents médico-chirurgicaux (dont allergies et traitements), une ligne par césarienne antérieure, antécédents obstétricaux.
- **Examen d'entrée** (tant qu'il n'est pas enregistré) : taille, GS, et derniers Hb / GE / TDR / RPR de la CPN, datés. Les constantes (poids, TA, HU, BCF, présentation) ne sont **jamais** recopiées : elles sont montrées comme repère.
- **`rappelPrenatal`** dans la vue : terme à l'admission, dernière CPN, dernière échographie, laboratoire, préventions et **points d'attention** (allergies, VIH+, utérus cicatriciel, Rh−, drépanocytose, HTA/diabète/cardiopathie, grossesse multiple, présentation non céphalique, prématurité / terme dépassé, anémie, RPR+, anomalie du liquide, placenta prævia, facteurs de risque, absence de CPN).
