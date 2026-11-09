# Module Épidémiologie

Mise en œuvre du cahier des charges « Grandes lignes des sous-fenêtres du module Épidémiologie »
(AMI Santé Connect). API : `/api/epidemiologie` ; interface : `/admin/epidemiologie` (ami-sante).

## Socle commun (Partie I)

| Élément | Où |
| --- | --- |
| Référentiel géographique (pays → province → ville/territoire → zone → aire → formation sanitaire → communauté), codes uniques | `models/EntiteGeographique.js`, synchronisable depuis les établissements (`POST /territoires/synchroniser`) |
| Statuts communs : Brouillon, Soumis, À corriger, Validé, Rejeté, Archivé | `models/validationEpi.js` (greffon de schéma : statut, version, auteurs, historique avant/après) |
| Cycle de validation commun | `controllers/epidemiologie/commun.js` (`REGISTRE`, `modifier`, `soumettre`, `decider`, `archiver`) |
| Moteur de calcul partagé (réalisations des modules AMI, ratios, variations) | `config/moteurEpidemiologie.js` |
| Référentiels, profils, coefficients et fiches initiales | `config/epidemiologie.js` |

Règles de calcul appliquées partout : formule, numérateur et dénominateur renvoyés ; dénominateur
absent ou nul → « non calculable » (jamais 0 %) ; donnée manquante jamais remplacée par zéro ;
personnes dédupliquées ; résultats observés (modules AMI) distingués des estimés (populations cibles).

Une donnée validée n'est jamais écrasée : pour les référentiels (population, coefficient, plan,
indicateur) une modification crée une **nouvelle version** ; pour les enregistrements (cas, décès,
événement) la correction est historisée (ancienne et nouvelle valeur, motif obligatoire) et repasse
en validation. **Séparation saisie / validation** : l'auteur ou la personne qui soumet ne valide pas.

## Les dix sous-fenêtres

| N° | Sous-fenêtre | Routes principales |
| --- | --- | --- |
| — | Vue générale | `GET /tableau-de-bord` |
| 1 | Référentiel démographique | `/populations`, `/populations/synthese`, `/territoires` |
| 2 | Paramètres et coefficients | `/coefficients`, `/coefficients/applicables`, `/indicateurs` |
| 3 | Calcul des populations cibles | `/cibles/calcul`, `/cibles/simulation`, `/cibles`, `/cibles/synthese` |
| 4 | Planification et répartition | `/plans`, `/plans/:id/suivi`, `/plans/tableau`, `/plans/:id/proposition-geographique` |
| 5 | Surveillance épidémiologique | `/evenements` (notification, investigation, suivi, état), `/cas`, `/surveillance/tableau` |
| 6 | Morbidité et mortalité | `/morbidite`, `/deces`, `/deces/signalements`, `/morbi-mortalite/analyse` |
| 7 | Couvertures sanitaires | `/couvertures`, `/couvertures/structures` |
| 8 | Alertes et insuffisances | `/alertes` (détection, affectation, traitement, résolution, clôture), `/alertes/regles` |
| 9 | Rapports et exportation | `/rapports` (génération, régénération, validation), `/rapports/:numero/export?format=pdf\|excel\|csv` |
| 10 | Historique, validation, traçabilité | `/validation/*`, `/historique/*`, `/donnees/:type/:id/(soumettre\|decision\|archiver\|controle\|historique)` |

## Interconnexion avec les modules AMI (aucune deuxième saisie)

Les couvertures, le suivi des plans et les naissances vivantes sont calculés directement depuis :
CPN (consultations finalisées, rang de la visite par grossesse), Accouchement (dossiers, accoucheur
renseigné = assisté), Nouveau-né (naissances, visite de suivi à J7) et Vaccination (doses
administrées, carnet à la fin de la période pour zéro dose et sous-vaccination). Les enfants passés
« Décédé » apparaissent comme signalements à classifier dans le registre des décès.

## Profils (correspondance avec les rôles AMI)

| Profil du cahier | Rôles AMI | Droits |
| --- | --- | --- |
| Administrateur national, validateur désigné, responsable provincial, MCZ | Médecin chef de service, Médecin directeur | Paramétrage, validation, consolidation multi-structures |
| Épidémiologiste, planificateur | Médecins, infirmier·ères et sages-femmes titulaires ou superviseur·es | Saisie démographique, calculs, plans, investigation, rapports |
| Responsable de structure, personnel clinique | Tout le personnel | Notification, cas, morbidité, décès, actions correctives |
| Auditeur | Tout le personnel connecté | Consultation des agrégats et des journaux |

Hors profils de consolidation, les réalisations issues des modules AMI sont limitées à
l'établissement de connexion (cloisonnement des dossiers). Les références aux dossiers (AC-PAT,
AC-ENF) ne sont visibles que dans l'établissement du cas et ne figurent jamais dans les agrégats
ni les exports.

## Hors connexion

Notifications d'événements, cas, cas de morbidité et décès peuvent être saisis sans réseau
(intercepteur de l'espace administrateur, `X-Operation-Id` : jamais exécutés deux fois). Ils
arrivent en « Soumis » et ne sont jamais présentés comme consolidés avant validation.

## À valider avant mise en production

Les valeurs suivantes ne sont que des propositions, enregistrées en **brouillon** et sans effet
tant qu'un responsable ne les a pas validées (Ministère de la Santé, PEV, références OMS / UNICEF /
GAVI) :

- coefficients DEM-001 (femmes enceintes 4 %), DEM-002 (naissances attendues 4 %), DEM-003
  (nourrissons survivants 3,49 %) : source officielle obligatoire avant validation ;
- fiches des indicateurs de couverture (notamment le nombre de contacts CPN requis : 4 par défaut,
  8 selon les recommandations actuelles) ;
- seuils d'alerte : aucune règle à seuil n'est fournie ; elles sont créées et activées par les
  responsables avec la référence du document qui fixe le seuil ;
- liste des maladies (à aligner sur la SIMR / MAPE), causes de décès (CIM), définitions de cas,
  définition « zéro dose » et méthode d'abandon CPN (approche transversale proposée).

## Tests

`tests/epidemiologie.test.js` couvre les tests d'acceptation T01 à T20 de la Partie IV (base
MongoDB en mémoire, données fictives) et vérifie que toutes les lectures des écrans répondent et que
les neuf types de rapports se génèrent et s'exportent.
