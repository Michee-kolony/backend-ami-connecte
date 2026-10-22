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
  'journal.lecture': 'Consultation du journal d’audit',
  'acces.refuse': 'Accès refusé',
  'article.publication': 'Article de conseils publié',
  'article.suppression': 'Article de conseils supprimé',
  'article.commentaire.suppression': 'Commentaire d’article supprimé',
};

/**
 * Ajoute une entrée. Un échec d'écriture est signalé dans la console sans bloquer la requête
 * (et sans y écrire de données de santé).
 */
async function journaliser(req, { action, patienteId = null, ressource = null, resultat = 'autorisé', details } = {}) {
  try {
    await JournalAudit.create({
      acteur: req.soignant ? auteurDe(req.soignant) : undefined,
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
