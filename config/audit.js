// Écriture du journal d'audit. Ne jamais y placer de contenu clinique, mot de passe ou jeton :
// seulement l'acteur, l'action, la ressource, le résultat et des métadonnées minimales.
const JournalAudit = require('../models/JournalAudit');
const { auteurDe } = require('../models/commun');

/** Actions tracées et leur libellé (affiché dans l'historique du dossier). */
const ACTIONS = {
  'patiente.creation': 'Création du dossier',
  'patiente.modification': 'Modification des informations administratives',
  'patiente.suppression': 'Suppression définitive du dossier',
  'patiente.carte': 'Carte patiente générée (PDF)',
  'patiente.recherche': 'Recherche de patientes',
  'dossier.lecture': 'Ouverture du dossier',
  'suivi.lecture': 'Consultation du suivi (grossesse et rendez-vous)',
  'grossesse.creation': 'Nouvelle grossesse enregistrée',
  'grossesse.datation': 'Datation de la grossesse',
  'grossesse.issue': 'Issue de grossesse enregistrée',
  'consultation.creation': 'Consultation commencée',
  'consultation.modification': 'Brouillon de consultation modifié',
  'consultation.lecture': 'Consultation ouverte',
  'consultation.finalisation': 'Consultation finalisée',
  'consultation.addendum': 'Addendum ajouté',
  'consultation.annulation': 'Consultation annulée',
  'rdv.creation': 'Rendez-vous planifié',
  'rdv.modification': 'Rendez-vous modifié',
  'rdv.rappels': 'Rappels de rendez-vous envoyés aux patientes (notifications)',
  'journal.lecture': 'Consultation du journal d’audit',
  'acces.refuse': 'Accès refusé',
  'article.publication': 'Article de conseils publié',
  'article.approbation': 'Article de conseils approuvé',
  'article.suppression': 'Article de conseils supprimé',
  'echographie.creation': 'Échographie enregistrée',
  'article.commentaire.suppression': 'Commentaire d’article supprimé',
  'accouchement.admission': 'Admission en salle de travail',
  'accouchement.lecture': 'Ouverture du dossier d’accouchement',
  'accouchement.modification': 'Admission (identité, anamnèse) modifiée',
  'accouchement.examen': 'Examen clinique d’entrée enregistré',
  'accouchement.surveillance': 'Surveillance du travail saisie',
  'accouchement.alerte': 'Alerte du partogramme déclenchée',
  'accouchement.alerte.acquittement': 'Alerte du partogramme prise en charge',
  'accouchement.accouchement': 'Accouchement et délivrance enregistrés',
  'accouchement.postpartum': 'Surveillance post-partum saisie',
  'accouchement.traitement': 'Traitement post-partum enregistré',
  'accouchement.sortie': 'Examen de sortie et mesures préventives',
  'accouchement.cloture': 'Dossier d’accouchement clôturé',
  'accouchement.suppression': 'Dossier d’accouchement supprimé définitivement',
  'enfant.creation': 'Naissance enregistrée (dossier de l’enfant)',
  'enfant.enregistrement': 'Enfant né hors plateforme enregistré (vaccination)',
  'enfant.lecture': 'Ouverture du dossier de l’enfant',
  'enfant.modification': 'Dossier de l’enfant modifié',
  'enfant.photo': 'Photo de l’enfant ajoutée ou remplacée',
  'enfant.vaccination': 'Vaccination / supplémentation enregistrée',
  'enfant.suivi': 'Visite de suivi de l’enfant',
  'espace.connexion': 'Connexion à l’espace patiente',
  'espace.lecture': 'Consultation de l’espace patiente',
};

/**
 * Ajoute une entrée. Un échec d'écriture est signalé dans la console sans bloquer la requête
 * (et sans y écrire de données de santé).
 */
async function journaliser(req, { action, patienteId = null, ressource = null, resultat = 'autorisé', details } = {}) {
  try {
    await JournalAudit.create({
      acteur: req.soignant ? auteurDe(req.soignant)
        : req.patiente ? { id: req.patiente.id, nom: `${req.patiente.prenom} ${req.patiente.nom}`.trim(), role: 'Patiente', matricule: req.patiente.numero }
        : undefined,
      action,
      resultat,
      patienteId,
      ressource: ressource ?? undefined,
      details,
      methode: req.method,
      route: req.baseUrl + (req.route?.path ?? ''),
      requeteId: req.requeteId ?? null,
    });
  } catch (err) {
    console.error(`Journal d’audit : écriture impossible (${action}, requête ${req.requeteId}) :`, err.message);
  }
}

module.exports = { journaliser, ACTIONS };
