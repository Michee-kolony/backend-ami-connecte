// Relance communautaire par le RECO (relais communautaire) : référentiel du module.
// Spécification : « Mécanisme de fonctionnement de l'application de relance communautaire du RECO »
// (v1.0, 27 octobre 2026). Voir docs/relance-communautaire.md.
//
// Les définitions officielles de RAC, ARC, RPC, IRC et TCC, les délais de tolérance, priorités et
// calendriers ne sont PAS fixés ici : ce sont des paramètres versionnés (ParcoursRelance,
// RegleRelance) que l'équipe du projet valide avant activation. Les valeurs ci-dessous ne sont que
// des valeurs initiales proposées, inactives tant qu'elles ne sont pas validées.

const { ROLES } = require('../models/Soignant');

/** Statuts obligatoires d'une tâche (section 6). */
const STATUTS = [
  'Nouvelle', 'Attribuée', 'En cours', 'Contact établi', 'Visite planifiée', 'Orientée',
  'Réintégration confirmée', 'Non retrouvée', 'Refus / report', 'Doublon annulé',
  'Clôturée sans réintégration', 'Escaladée',
];
/** Statuts de clôture : la tâche n'est plus active. */
const STATUTS_FINAUX = ['Réintégration confirmée', 'Doublon annulé', 'Clôturée sans réintégration'];
/** Résultat du RECO en attente de décision du superviseur (tâche encore ouverte). */
const STATUTS_SUPERVISION = ['Non retrouvée', 'Refus / report', 'Escaladée'];
/** Statuts dans lesquels le RECO peut encore agir. */
const STATUTS_RECO = ['Attribuée', 'En cours', 'Contact établi', 'Visite planifiée', 'Orientée'];

const DOMAINES = ['CPN', 'Accouchement', 'Postnatal', 'Vaccination', 'Suivi communautaire'];
const PRIORITES = ['Normale', 'Prioritaire', 'Urgente'];
const SOURCES = ['Détection automatique', 'CPN', 'Vaccination', 'Structure', 'RECO', 'Autre source autorisée'];

/** Canaux de contact et leur consentement dans le dossier (Patiente.consentements). */
const CANAUX = ['Appel', 'SMS', 'WhatsApp', 'Visite à domicile'];
const CONSENTEMENT_CANAL = { Appel: 'appel', SMS: 'sms', WhatsApp: 'whatsapp' };

/** Résultat codifié d'une tentative de contact ou d'une visite. */
const RESULTATS_TENTATIVE = [
  'Personne jointe', 'Responsable légal autorisé joint', 'Pas de réponse', 'Numéro erroné ou injoignable',
  'Interlocuteur non autorisé', 'Message neutre envoyé',
];
/** Résultat d'une visite à domicile réalisée. */
const RESULTATS_VISITE = [
  'Personne rencontrée', 'Responsable légal autorisé rencontré', 'Absente du domicile', 'Adresse introuvable', 'A déménagé',
];
/** Résultats qui établissent le contact (statut « Contact établi »). */
const RESULTATS_CONTACT = ['Personne jointe', 'Responsable légal autorisé joint', 'Personne rencontrée', 'Responsable légal autorisé rencontré'];
/** Résultats neutres : ni contact, ni échec (message déposé, réponse attendue). */
const RESULTATS_NEUTRES = ['Message neutre envoyé'];

/** Motifs de refus ou de report : formulés sans stigmatisation. */
const MOTIFS_REFUS = ['Refus exprimé', 'Report demandé', 'Suivie dans une autre structure', 'Indisponible pour le moment', 'Autre'];

/** Résultat codifié de clôture (section 5, étape 9). */
const RESULTATS_CLOTURE = [
  'Réintégration confirmée', 'Non retrouvée', 'Refus', 'Report sans suite', 'Suivie dans une autre structure',
  'A déménagé hors de l’aire de santé', 'Décès signalé', 'Prestation déjà reçue', 'Doublon', 'Autre',
];

/** Actions du RECO (application RECO, en ligne ou hors connexion). */
const ACTIONS_RECO = ['accepter', 'tentative', 'visite_planifiee', 'visite_realisee', 'orientation', 'refus_report', 'demande_appui', 'urgence'];

/** Commentaire du RECO : limité, sans détail clinique. */
const COMMENTAIRE_MAX = 280;

/**
 * Rôles du personnel (section 3). Choix du projet : TOUT le personnel soignant (médecins,
 * sages-femmes, infirmier·ères, quel que soit leur grade) a accès à toute la relance
 * communautaire : tableau de bord, tâches nominatives de sa structure, supervision, comptes RECO
 * (ajout, modification, suspension, suppression) et paramétrage. Les RECO, les patientes et les
 * chauffeurs n'y ont pas accès (jetons refusés sur ces routes). Pour restreindre plus tard,
 * il suffit de remplacer ROLES par une liste de rôles dans les constantes ci-dessous.
 */
const ROLES_SUPERVISION = ROLES;
const ROLES_RESPONSABLE = ROLES;
const ROLES_PARAMETRAGE = ROLES;
/** Confirmation d'une prestation dans le dossier de soins : tout soignant (prestataire). */
const ROLES_PRESTATAIRE = ROLES;

/** Codes des cinq parcours (section 7) : définitions à saisir et valider par le projet. */
const CODES_PARCOURS = ['RAC', 'ARC', 'RPC', 'IRC', 'TCC'];
const STATUTS_PARCOURS = ['À valider', 'Validé', 'Suspendu'];
const STATUTS_REGLE = ['Inactive', 'Active', 'Suspendue'];

/**
 * Déclencheurs (section 4) gérés par le moteur. Les paramètres sont des valeurs initiales
 * proposées, à confirmer avec les protocoles RDC/PEV : chaque règle reste inactive tant qu'un
 * responsable ne l'a pas validée et rattachée à un parcours validé.
 *
 * toleranceJours           : délai après l'événement attendu avant de créer la relance ;
 * fenetreJours             : ancienneté maximale de l'événement (les situations plus anciennes ne sont pas reprises) ;
 * delaiTraitementJours     : échéance de la tâche après sa création ;
 * tentativesMax            : tentatives infructueuses avant « Non retrouvée » ;
 * alerteAvantEcheanceJours : rappel au RECO avant l'échéance ;
 * priseEnChargeHeures      : délai de prise en charge d'une tâche urgente avant alerte du superviseur ;
 * confirmationOrientationJours : délai avant alerte de la structure pour une orientation non confirmée.
 */
const parametresCommuns = {
  tentativesMax: 3, alerteAvantEcheanceJours: 1, priseEnChargeHeures: 24, confirmationOrientationJours: 7,
};
const REGLES_INITIALES = [
  {
    code: 'CPN_RDV_MANQUE', domaine: 'CPN', libelle: 'Rendez-vous de consultation prénatale manqué',
    description: 'Rendez-vous CPN passé de plus du délai de tolérance, sans consultation enregistrée depuis.',
    parametres: { ...parametresCommuns, toleranceJours: 7, fenetreJours: 90, delaiTraitementJours: 7, priorite: 'Normale' },
  },
  {
    code: 'ACC_ISSUE_INCONNUE', domaine: 'Accouchement', libelle: 'Date prévue d’accouchement dépassée sans issue connue',
    description: 'Grossesse en cours dont la DPA retenue est dépassée du délai de tolérance, sans issue ni dossier d’accouchement.',
    parametres: { ...parametresCommuns, toleranceJours: 14, fenetreJours: 120, delaiTraitementJours: 3, priorite: 'Prioritaire' },
  },
  {
    code: 'PN_VISITE_NON_DOCUMENTEE', domaine: 'Postnatal', libelle: 'Visite postnatale attendue non documentée',
    description: 'Nouveau-né vivant suivi, sans visite de suivi de l’enfant ni consultation postnatale de la mère après le délai de tolérance.',
    parametres: { ...parametresCommuns, toleranceJours: 7, fenetreJours: 42, delaiTraitementJours: 3, priorite: 'Prioritaire' },
  },
  {
    code: 'VAC_DOSE_NON_DOCUMENTEE', domaine: 'Vaccination', libelle: 'Dose de vaccin attendue non documentée',
    description: 'Dose du calendrier PEV « En retard » depuis plus du délai de tolérance après sa date prévue ; enfant zéro-dose signalé.',
    parametres: { ...parametresCommuns, toleranceJours: 14, fenetreJours: 1830, delaiTraitementJours: 7, priorite: 'Normale' },
  },
];
const CODES_REGLES = REGLES_INITIALES.map((r) => r.code);
/** Paramètres des tâches sans règle (situation signalée par un RECO, en attente de vérification). */
const PARAMETRES_SIGNALEMENT = { ...parametresCommuns, delaiTraitementJours: 3, priorite: 'Prioritaire' };

/** Bornes de chaque paramètre modifiable (validation du paramétrage). */
const BORNES_PARAMETRES = {
  toleranceJours: [0, 365], fenetreJours: [1, 1830], delaiTraitementJours: [1, 90], tentativesMax: [1, 10],
  alerteAvantEcheanceJours: [0, 30], priseEnChargeHeures: [1, 168], confirmationOrientationJours: [1, 60],
};

/** Types d'alerte (section 10) et leur destinataire. */
const ALERTES = {
  attribution: { libelle: 'Nouvelles tâches attribuées', destinataire: 'reco' },
  echeance_proche: { libelle: 'Tâches arrivant à échéance', destinataire: 'reco' },
  non_attribuee: { libelle: 'Tâches sans RECO attribué', destinataire: 'supervision' },
  urgente_non_prise: { libelle: 'Tâches urgentes non prises en charge', destinataire: 'supervision' },
  retard: { libelle: 'Tâches en retard (échéance dépassée)', destinataire: 'supervision' },
  echecs_multiples: { libelle: 'Personnes non retrouvées après plusieurs tentatives', destinataire: 'supervision' },
  appui: { libelle: 'Demandes d’appui et cas escaladés', destinataire: 'supervision' },
  urgence: { libelle: 'Danger ou besoin clinique urgent signalé par un RECO', destinataire: 'supervision' },
  orientation_non_confirmee: { libelle: 'Orientations dont la réception n’est pas confirmée', destinataire: 'structure' },
  conflit: { libelle: 'Conflits de synchronisation à arbitrer', destinataire: 'supervision' },
  signalement: { libelle: 'Situations signalées par un RECO à vérifier', destinataire: 'supervision' },
};

/**
 * Motif affiché au RECO, sans détail clinique : il sait pourquoi il relance, sans diagnostic,
 * statut sérologique ni autre donnée sensible.
 */
const MOTIF_RECO = {
  CPN: 'Rendez-vous de suivi au centre de santé manqué',
  Accouchement: 'Nouvelles à prendre après la date prévue de suivi',
  Postnatal: 'Visite de suivi après la naissance à faire',
  Vaccination: 'Séance de l’enfant au centre de santé à faire',
  'Suivi communautaire': 'Situation à vérifier',
};

/**
 * Message neutre (SMS / WhatsApp) : aucune mention de grossesse, de diagnostic ni de statut
 * vaccinal, lisible sans risque sur un téléphone partagé.
 */
function messageNeutre({ reco, structure }) {
  const qui = reco ? `${reco.prenom} ${reco.nom}`.trim() : 'votre relais communautaire';
  const tel = reco?.telephone ? ` ou de me rappeler au ${reco.telephone}` : '';
  return `Bonjour, ici ${qui}, relais communautaire de votre quartier. Merci de passer au ${structure || 'centre de santé'}${tel}. Bonne journée.`;
}

/** Effectifs inférieurs à ce seuil masqués dans les désagrégations (petits effectifs identifiants). */
const SEUIL_PETITS_EFFECTIFS = 5;

/** Auteur des actions du moteur (détection, alertes, confirmation depuis le dossier de soins). */
const AUTEUR_SYSTEME = { id: 'systeme', nom: 'Moteur de relance AMI', role: 'Système', matricule: '' };

const JOUR = 86400000;

module.exports = {
  STATUTS, STATUTS_FINAUX, STATUTS_SUPERVISION, STATUTS_RECO, DOMAINES, PRIORITES, SOURCES, CANAUX, CONSENTEMENT_CANAL,
  RESULTATS_TENTATIVE, RESULTATS_VISITE, RESULTATS_CONTACT, RESULTATS_NEUTRES, MOTIFS_REFUS, RESULTATS_CLOTURE, ACTIONS_RECO, COMMENTAIRE_MAX,
  ROLES_SUPERVISION, ROLES_RESPONSABLE, ROLES_PARAMETRAGE, ROLES_PRESTATAIRE,
  CODES_PARCOURS, STATUTS_PARCOURS, STATUTS_REGLE, REGLES_INITIALES, CODES_REGLES, PARAMETRES_SIGNALEMENT, BORNES_PARAMETRES,
  ALERTES, MOTIF_RECO, messageNeutre, SEUIL_PETITS_EFFECTIFS, AUTEUR_SYSTEME, JOUR,
};
