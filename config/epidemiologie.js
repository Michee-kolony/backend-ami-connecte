// Module ÉPIDÉMIOLOGIE d'AMI Santé Connect : référentiel commun aux dix sous-fenêtres.
// Spécification : « Grandes lignes des sous-fenêtres du module Épidémiologie — architecture
// fonctionnelle et cahier des charges développeur ». Voir docs/epidemiologie.md.
//
// Règle du cahier des charges : les coefficients, seuils d'alerte et définitions d'indicateurs ne
// sont PAS figés dans le code. Les valeurs ci-dessous ne sont que des propositions initiales,
// enregistrées en « Brouillon » : elles ne servent à aucun calcul officiel avant leur validation
// (Ministère de la Santé, PEV, références OMS / UNICEF / GAVI).
const { ROLES, ROLES_MEDECIN } = require('../models/Soignant');

// --- Socle commun (Partie I) -------------------------------------------------------------

/** Hiérarchie géographique du système sanitaire congolais (Partie I, §1). */
const NIVEAUX = ['Pays', 'Province', 'Ville/territoire', 'Zone de santé', 'Aire de santé', 'Formation sanitaire', 'Communauté'];

/** Statuts communs des données (Partie I, §3). */
const STATUTS = ['Brouillon', 'Soumis', 'À corriger', 'Validé', 'Rejeté', 'Archivé'];
/** Décisions de validation (sous-fenêtre 10). */
const DECISIONS = { valider: 'Validé', rejeter: 'Rejeté', corriger: 'À corriger' };

/** Nature d'une valeur (règle 19 : résultats estimés, projetés et observés). */
const NATURES = ['Observée', 'Estimée', 'Projetée'];

/** Séparation entre les utilisateurs qui saisissent et ceux qui valident (Partie III, §4). */
const SEPARATION_SAISIE_VALIDATION = true;

/**
 * Correspondance des profils du cahier des charges avec les rôles AMI :
 *   - administrateur national, validateur désigné, responsable provincial, médecin chef de zone
 *     → médecin chef de service, médecin directeur (paramétrage, validation, consolidation) ;
 *   - épidémiologiste, planificateur → médecins, infirmier·ères et sages-femmes titulaires ou superviseur·es ;
 *   - responsable de structure, personnel clinique → tout le personnel (notification, saisie locale) ;
 *   - auditeur → consultation (tout le personnel connecté peut consulter les agrégats).
 */
const ROLES_VALIDATION = ['Médecin chef de service', 'Médecin directeur'];
const ROLES_PARAMETRAGE = ROLES_VALIDATION;
const ROLES_CONSOLIDATION = ROLES_VALIDATION;
const ROLES_PLANIFICATION = [
  ...ROLES_MEDECIN, 'Infirmier(ère) titulaire', 'Infirmier(ère) superviseur(e)', 'Sage-femme titulaire', 'Sage-femme superviseur(e)',
];
const ROLES_SAISIE = ROLES;

// --- Sous-fenêtre 1 : référentiel démographique -------------------------------------------

/** Groupes d'âge (à adapter au référentiel national) ; des groupes spécifiques PEV peuvent s'ajouter. */
const TRANCHES_AGE = [
  { code: '0-0', libelle: 'Moins d’un an', min: 0, max: 0 },
  { code: '1-4', libelle: '1 à 4 ans', min: 1, max: 4 },
  { code: '5-9', libelle: '5 à 9 ans', min: 5, max: 9 },
  { code: '10-14', libelle: '10 à 14 ans', min: 10, max: 14 },
  { code: '15-19', libelle: '15 à 19 ans', min: 15, max: 19 },
  { code: '20-24', libelle: '20 à 24 ans', min: 20, max: 24 },
  { code: '25-49', libelle: '25 à 49 ans', min: 25, max: 49 },
  { code: '50-59', libelle: '50 à 59 ans', min: 50, max: 59 },
  { code: '60+', libelle: '60 ans et plus', min: 60, max: null },
];
const SOURCES_DEMOGRAPHIQUES = ['Recensement', 'Projection', 'Estimation officielle', 'Autre'];
const METHODES = ['Recensement', 'Projection', 'Estimation'];

// --- Sous-fenêtre 2 : coefficients --------------------------------------------------------

/** Populations cibles calculées par le moteur (codes stables, utilisés par les indicateurs). */
const CIBLES = {
  FE: 'Femmes enceintes attendues',
  NA: 'Naissances attendues',
  NS: 'Nourrissons survivants',
};
const PROGRAMMES = ['CPN', 'Accouchement', 'Vaccination', 'Nutrition', 'Autre'];

/** Paramètres initiaux à prévoir (§2.4) : enregistrés en brouillon, à confirmer avant activation. */
const COEFFICIENTS_INITIAUX = [
  { code: 'DEM-001', nom: 'Femmes enceintes', cible: 'FE', valeurPct: 4, programme: 'CPN' },
  { code: 'DEM-002', nom: 'Naissances attendues', cible: 'NA', valeurPct: 4, programme: 'Accouchement' },
  { code: 'DEM-003', nom: 'Nourrissons survivants', cible: 'NS', valeurPct: 3.49, programme: 'Vaccination' },
];

/** Règle d'arrondi du référentiel de calcul (§3.5) : entier le plus proche, demi supérieur. */
const ARRONDI = 'Entier le plus proche (0,5 arrondi au-dessus)';
const arrondir = (x) => Math.round(x);

// --- Sous-fenêtre 4 : planification ------------------------------------------------------

/** Interventions planifiables et population cible de référence (sous-fenêtre 3). */
const INTERVENTIONS = [
  { code: 'CPN1', libelle: 'CPN 1', cible: 'FE', programme: 'CPN' },
  { code: 'CPN4', libelle: 'CPN 4 (contacts requis)', cible: 'FE', programme: 'CPN' },
  { code: 'ACC', libelle: 'Accouchements assistés', cible: 'NA', programme: 'Accouchement' },
  { code: 'CPON', libelle: 'Consultations postnatales', cible: 'NA', programme: 'Accouchement' },
  { code: 'BCG', libelle: 'BCG', cible: 'NA', programme: 'Vaccination' },
  { code: 'PENTA1', libelle: 'Penta 1', cible: 'NS', programme: 'Vaccination' },
  { code: 'PENTA3', libelle: 'Penta 3', cible: 'NS', programme: 'Vaccination' },
  { code: 'VPO3', libelle: 'VPO 3', cible: 'NS', programme: 'Vaccination' },
  { code: 'PCV3', libelle: 'PCV13 - 3', cible: 'NS', programme: 'Vaccination' },
  { code: 'ROTA3', libelle: 'Rota 3', cible: 'NS', programme: 'Vaccination' },
  { code: 'VAR1', libelle: 'RR 1 (rougeole)', cible: 'NS', programme: 'Vaccination' },
  { code: 'VAA', libelle: 'VAA (fièvre jaune)', cible: 'NS', programme: 'Vaccination' },
];
const PAR_INTERVENTION = new Map(INTERVENTIONS.map((i) => [i.code, i]));

// --- Sous-fenêtre 5 : surveillance --------------------------------------------------------

const TYPES_EVENEMENT = ['Maladie', 'Décès inhabituel', 'Intoxication', 'Autre'];
/** Maladies et événements suivis (liste de départ, à aligner sur la SIMR / MAPE de la RDC). */
const MALADIES = [
  { code: 'CHOLERA', libelle: 'Choléra', categorie: 'Potentiel épidémique' },
  { code: 'ROUGEOLE', libelle: 'Rougeole', categorie: 'Potentiel épidémique' },
  { code: 'MENINGITE', libelle: 'Méningite', categorie: 'Potentiel épidémique' },
  { code: 'FIEVRE_JAUNE', libelle: 'Fièvre jaune', categorie: 'Potentiel épidémique' },
  { code: 'EBOLA', libelle: 'Maladie à virus Ebola', categorie: 'Potentiel épidémique' },
  { code: 'MPOX', libelle: 'Mpox (variole simienne)', categorie: 'Potentiel épidémique' },
  { code: 'PESTE', libelle: 'Peste', categorie: 'Potentiel épidémique' },
  { code: 'PFA', libelle: 'Paralysie flasque aiguë (polio)', categorie: 'Potentiel épidémique' },
  { code: 'TNN', libelle: 'Tétanos néonatal', categorie: 'Potentiel épidémique' },
  { code: 'COVID19', libelle: 'COVID-19', categorie: 'Potentiel épidémique' },
  { code: 'FHV', libelle: 'Fièvre hémorragique virale (autre)', categorie: 'Potentiel épidémique' },
  { code: 'DIARRHEE_SANG', libelle: 'Diarrhée sanglante (shigellose)', categorie: 'Potentiel épidémique' },
  { code: 'PALUDISME', libelle: 'Paludisme', categorie: 'Transmissible' },
  { code: 'PALU_GRAVE', libelle: 'Paludisme grave', categorie: 'Transmissible' },
  { code: 'IRA', libelle: 'Infection respiratoire aiguë', categorie: 'Transmissible' },
  { code: 'DIARRHEE', libelle: 'Maladie diarrhéique', categorie: 'Transmissible' },
  { code: 'TUBERCULOSE', libelle: 'Tuberculose', categorie: 'Transmissible' },
  { code: 'VIH', libelle: 'Infection à VIH', categorie: 'Transmissible' },
  { code: 'TYPHOIDE', libelle: 'Fièvre typhoïde', categorie: 'Transmissible' },
  { code: 'MALNUTRITION', libelle: 'Malnutrition aiguë', categorie: 'Non transmissible' },
  { code: 'HTA', libelle: 'Hypertension artérielle', categorie: 'Non transmissible' },
  { code: 'DIABETE', libelle: 'Diabète', categorie: 'Non transmissible' },
  { code: 'DREPANOCYTOSE', libelle: 'Drépanocytose', categorie: 'Non transmissible' },
  { code: 'ANEMIE', libelle: 'Anémie', categorie: 'Non transmissible' },
  { code: 'INTOXICATION', libelle: 'Intoxication', categorie: 'Autre événement' },
  { code: 'AUTRE', libelle: 'Autre maladie ou événement', categorie: 'Autre événement' },
];
const PAR_MALADIE = new Map(MALADIES.map((m) => [m.code, m]));
const CATEGORIES_MALADIE = ['Transmissible', 'Non transmissible', 'Potentiel épidémique', 'Autre événement'];
const PRIORITES = ['Critique', 'Élevée', 'Modérée', 'Information'];
const STATUTS_EVENEMENT = ['Nouveau', 'Vérifié', 'En investigation', 'En suivi', 'Clôturé'];
const RESULTATS_LABO = ['En attente', 'Positif', 'Négatif', 'Indéterminé', 'Non réalisé'];
const CLASSIFICATIONS_CAS = ['Suspect', 'Probable', 'Confirmé', 'Non-cas'];
const ISSUES_CAS = ['En cours', 'Guéri', 'Décédé', 'Perdu de vue', 'Inconnue'];
const SEXES = ['Masculin', 'Féminin', 'Inconnu'];

// --- Sous-fenêtre 6 : morbidité et mortalité ----------------------------------------------

const SERVICES = ['Maternité', 'Pédiatrie', 'Médecine interne', 'Chirurgie', 'Néonatologie', 'Urgences', 'Consultation externe', 'Autre'];
const CLASSIFICATIONS_MORBIDITE = ['Confirmé', 'Probable', 'Présomptif (clinique)'];
const ISSUES_MORBIDITE = ['Guérison', 'Amélioration', 'Transfert', 'Décès', 'Autre', 'En cours'];
const LIEUX_DECES = ['Structure sanitaire', 'Communauté', 'En cours de transfert', 'Autre'];
const OUI_NON_ND = ['Oui', 'Non', 'Non déterminé'];
const SOURCES_DECES = ['Registre', 'Certificat de décès', 'Notification', 'Audit (SDMPR)', 'Autre'];
/** Causes de décès (liste contrôlée de départ, à aligner sur la CIM-10/11 et la nomenclature nationale). */
const CAUSES_DECES = [
  'Hémorragie obstétricale', 'Troubles hypertensifs (pré-éclampsie, éclampsie)', 'Infection puerpérale / sepsis maternel',
  'Complications d’avortement', 'Dystocie / rupture utérine', 'Asphyxie néonatale', 'Prématurité / faible poids de naissance',
  'Infection néonatale', 'Paludisme', 'Pneumonie / IRA', 'Maladie diarrhéique', 'Malnutrition', 'Rougeole', 'Anémie',
  'VIH / SIDA', 'Tuberculose', 'Traumatisme / accident', 'Maladie cardiovasculaire', 'Autre cause', 'Cause indéterminée',
];
/** Unité des taux de fréquence (configurable par indicateur, §6.5 A). */
const UNITES_FREQUENCE = [1000, 100000];

// --- Sous-fenêtre 7 : couvertures (catalogue des indicateurs) -----------------------------

/**
 * Fiches techniques initiales des indicateurs de couverture (§7.3–7.4), en brouillon jusqu'à
 * validation. `realisation` : code de réalisation calculé dans les modules AMI
 * (config/moteurEpidemiologie.js) ; `cible` : dénominateur (population cible de la sous-fenêtre 3).
 */
const INDICATEURS_INITIAUX = [
  { code: 'COUV-CPN1', nom: 'Couverture CPN1', intervention: 'CPN1', realisation: 'CPN1', cible: 'FE',
    numerateur: 'Femmes ayant effectué une première CPN pendant la période (module CPN, consultations finalisées).', seuil: null },
  { code: 'COUV-CPN4', nom: 'Couverture CPN4 (contacts requis)', intervention: 'CPN4', realisation: 'CPN4', cible: 'FE',
    numerateur: 'Femmes ayant atteint pendant la période le nombre de contacts CPN requis par le protocole retenu.', parametres: { contactsRequis: 4 } },
  { code: 'COUV-ACC', nom: 'Couverture des accouchements assistés', intervention: 'ACC', realisation: 'ACC', cible: 'NA',
    numerateur: 'Accouchements assistés par un personnel qualifié (dossier d’accouchement avec accoucheur renseigné).' },
  { code: 'COUV-CPON', nom: 'Couverture des consultations postnatales', intervention: 'CPON', realisation: 'CPON', cible: 'NA',
    numerateur: 'Nouveau-nés vivants de la période ayant eu une visite de suivi dans les 7 jours suivant la naissance.' },
  { code: 'COUV-BCG', nom: 'Couverture BCG', intervention: 'BCG', realisation: 'BCG', cible: 'NA',
    numerateur: 'Enfants ayant reçu le BCG pendant la période (module Vaccination).' },
  { code: 'COUV-PENTA1', nom: 'Couverture Penta 1', intervention: 'PENTA1', realisation: 'PENTA1', cible: 'NS',
    numerateur: 'Enfants ayant reçu la 1re dose de DTC-HepB-Hib pendant la période.' },
  { code: 'COUV-PENTA3', nom: 'Couverture Penta 3', intervention: 'PENTA3', realisation: 'PENTA3', cible: 'NS',
    numerateur: 'Enfants ayant reçu la 3e dose de DTC-HepB-Hib pendant la période.' },
  { code: 'COUV-VPO3', nom: 'Couverture VPO 3', intervention: 'VPO3', realisation: 'VPO3', cible: 'NS',
    numerateur: 'Enfants ayant reçu la 3e dose de VPO pendant la période.' },
  { code: 'COUV-PCV3', nom: 'Couverture PCV13 - 3', intervention: 'PCV3', realisation: 'PCV3', cible: 'NS',
    numerateur: 'Enfants ayant reçu la 3e dose de PCV13 pendant la période.' },
  { code: 'COUV-ROTA3', nom: 'Couverture Rota 3', intervention: 'ROTA3', realisation: 'ROTA3', cible: 'NS',
    numerateur: 'Enfants ayant reçu la 3e dose antirotavirus pendant la période.' },
  { code: 'COUV-VAR1', nom: 'Couverture RR 1 (rougeole)', intervention: 'VAR1', realisation: 'VAR1', cible: 'NS',
    numerateur: 'Enfants ayant reçu la 1re dose de RR pendant la période.' },
  { code: 'COUV-VAA', nom: 'Couverture VAA (fièvre jaune)', intervention: 'VAA', realisation: 'VAA', cible: 'NS',
    numerateur: 'Enfants ayant reçu le VAA pendant la période.' },
];
const UNITES_INDICATEUR = ['Pourcentage', 'Taux', 'Nombre'];
const PERIODICITES = ['Mensuelle', 'Trimestrielle', 'Annuelle'];
const DESAGREGATIONS = ['Âge', 'Sexe', 'Territoire', 'Structure'];

// --- Sous-fenêtre 8 : alertes -------------------------------------------------------------

const DOMAINES_ALERTE = [
  'Démographie', 'Coefficients', 'Calculs', 'Planification', 'Surveillance', 'Morbidité', 'Mortalité',
  'CPN', 'Vaccination', 'Abandon', 'Zéro dose', 'Qualité des données', 'Opérationnel',
];
const STATUTS_REGLE = ['Brouillon', 'Active', 'Suspendue', 'Archivée'];
const STATUTS_ALERTE = ['Nouvelle', 'Attribuée', 'En cours', 'Résolue', 'Clôturée'];
const STATUTS_ALERTE_OUVERTS = ['Nouvelle', 'Attribuée', 'En cours'];
/** Indicateurs surveillables par une règle (les seuils sont saisis et validés par les responsables). */
const INDICATEURS_ALERTE = [
  { code: 'COUVERTURE', libelle: 'Couverture d’un indicateur (%)', parametre: 'indicateur', domaine: 'Vaccination' },
  { code: 'ABANDON_PENTA', libelle: 'Taux d’abandon Penta1-Penta3 (%)', domaine: 'Abandon' },
  { code: 'ABANDON_CPN', libelle: 'Taux d’abandon CPN1-CPN4 (%)', domaine: 'Abandon' },
  { code: 'ZERO_DOSE', libelle: 'Enfants zéro dose (nombre)', domaine: 'Zéro dose' },
  { code: 'CAS_MALADIE', libelle: 'Cas notifiés d’une maladie sur la période (nombre)', parametre: 'maladie', domaine: 'Surveillance' },
  { code: 'DECES_MATERNELS', libelle: 'Décès maternels sur la période (nombre)', domaine: 'Mortalité' },
  { code: 'DECES_NEONATALS', libelle: 'Décès néonatals sur la période (nombre)', domaine: 'Mortalité' },
  { code: 'HAUSSE_CAS', libelle: 'Hausse des cas d’une maladie vs période précédente (%)', parametre: 'maladie', domaine: 'Morbidité' },
];
const OPERATEURS = ['<', '<=', '>', '>='];

// --- Sous-fenêtre 9 : rapports ------------------------------------------------------------

const TYPES_RAPPORT = {
  demographique: 'Rapport démographique',
  cibles: 'Rapport des populations cibles',
  planification: 'Rapport de planification',
  surveillance: 'Rapport de surveillance épidémiologique',
  morbidite: 'Rapport de morbidité',
  mortalite: 'Rapport de mortalité',
  couvertures: 'Rapport des couvertures sanitaires',
  alertes: 'Rapport des alertes et insuffisances',
  synthese: 'Rapport de synthèse (mensuel, trimestriel ou annuel)',
};
const FORMATS = ['PDF', 'Excel', 'CSV'];
const STATUTS_RAPPORT = ['Disponible', 'Validé', 'Remplacé'];

module.exports = {
  NIVEAUX, STATUTS, DECISIONS, NATURES, SEPARATION_SAISIE_VALIDATION,
  ROLES_VALIDATION, ROLES_PARAMETRAGE, ROLES_CONSOLIDATION, ROLES_PLANIFICATION, ROLES_SAISIE,
  TRANCHES_AGE, SOURCES_DEMOGRAPHIQUES, METHODES,
  CIBLES, PROGRAMMES, COEFFICIENTS_INITIAUX, ARRONDI, arrondir,
  INTERVENTIONS, PAR_INTERVENTION,
  TYPES_EVENEMENT, MALADIES, PAR_MALADIE, CATEGORIES_MALADIE, PRIORITES, STATUTS_EVENEMENT, RESULTATS_LABO, CLASSIFICATIONS_CAS, ISSUES_CAS, SEXES,
  SERVICES, CLASSIFICATIONS_MORBIDITE, ISSUES_MORBIDITE, LIEUX_DECES, OUI_NON_ND, SOURCES_DECES, CAUSES_DECES, UNITES_FREQUENCE,
  INDICATEURS_INITIAUX, UNITES_INDICATEUR, PERIODICITES, DESAGREGATIONS,
  DOMAINES_ALERTE, STATUTS_REGLE, STATUTS_ALERTE, STATUTS_ALERTE_OUVERTS, INDICATEURS_ALERTE, OPERATEURS,
  TYPES_RAPPORT, FORMATS, STATUTS_RAPPORT,
};
