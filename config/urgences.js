// Urgences (alertes de détresse des patientes) et flotte d'ambulances : référentiels partagés
// par les modèles, les contrôleurs et les trois applications (admin, patiente, chauffeur).

/** Motifs proposés dans l'application patiente, avec la gravité retenue pour la régulation. */
const MOTIFS = [
  { code: 'saignements', libelle: 'Saignements', gravite: 'critique' },
  { code: 'convulsions', libelle: 'Convulsions, perte de connaissance', gravite: 'critique' },
  { code: 'bebe', libelle: 'Mon bébé ne bouge plus / ne va pas bien', gravite: 'critique' },
  { code: 'douleurs', libelle: 'Douleurs prénatales', gravite: 'élevée' },
  { code: 'contractions', libelle: 'Contractions fortes', gravite: 'élevée' },
  { code: 'poche', libelle: 'Perte des eaux', gravite: 'élevée' },
  { code: 'malaise', libelle: 'Fièvre, malaise', gravite: 'modérée' },
  { code: 'autre', libelle: 'Autre urgence', gravite: 'modérée' },
];

const GRAVITES = ['critique', 'élevée', 'modérée'];
/** État de l'alerte pour la régulation. */
const ETATS = ['nouvelle', 'prise en charge', 'résolue', 'annulée'];
const ETATS_ACTIFS = ['nouvelle', 'prise en charge'];

/**
 * Statut de la course, indiqué par le chauffeur depuis son application, dans cet ordre.
 * « Terminée » clôt l'urgence et libère l'ambulance.
 */
const STATUTS_COURSE = ['Assignée', 'En route', 'Arrivée sur place', 'Patiente à bord', 'Arrivée à l’hôpital', 'Terminée'];

const TYPES_EVENEMENT = [
  'Alerte reçue', 'Prise en charge', 'Ambulance envoyée', 'En route', 'Arrivée sur place', 'Patiente à bord',
  'Arrivée à l’hôpital', 'Clôturée', 'Annulée',
];

const STATUTS_AMBULANCE = ['Disponible', 'En mission', 'Maintenance', 'Hors service'];
const TYPES_AMBULANCE = ['Type A — transport', 'Type B — soins d’urgence', 'Type C — réanimation'];
const STATUTS_CHAUFFEUR = ['Actif', 'Suspendu'];

/** Intervalle minimal entre deux positions diffusées pour une même ambulance (ms). */
const INTERVALLE_POSITION_MS = 800;
/** Intervalle d'enregistrement de la position en base (la diffusion, elle, suit chaque seconde). */
const INTERVALLE_SAUVEGARDE_MS = 5000;

/**
 * Cloisonnement de la régulation : le personnel ne voit et ne traite que les urgences de son
 * établissement de connexion (celui de la patiente). Une urgence sans établissement (patiente
 * non rattachée) reste visible de toute la régulation, pour ne jamais rester sans réponse.
 */
const urgenceVisible = (x, etablissementId) => !x.etablissementId || (!!etablissementId && x.etablissementId === etablissementId);
const filtreRegulation = (etablissementId) => ({ etablissementId: { $in: etablissementId ? [etablissementId, null] : [null] } });

/** Flotte (ambulances, chauffeurs) de l'établissement de connexion ; aucune sans établissement. */
const filtreFlotte = (etablissementId) => (etablissementId ? { etablissementId } : { _id: { $in: [] } });

module.exports = {
  urgenceVisible, filtreRegulation, filtreFlotte,
  MOTIFS, GRAVITES, ETATS, ETATS_ACTIFS, STATUTS_COURSE, TYPES_EVENEMENT,
  STATUTS_AMBULANCE, TYPES_AMBULANCE, STATUTS_CHAUFFEUR, INTERVALLE_POSITION_MS, INTERVALLE_SAUVEGARDE_MS,
};
