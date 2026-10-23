const crypto = require('crypto');
const { ROLES_MEDECIN, ROLES_MATERNITE } = require('../models/Soignant');
const { journaliser } = require('../config/audit');

/** Identifiant de corrélation de chaque requête (renvoyé dans l'en-tête X-Request-Id). */
function identifierRequete(req, res, next) {
  req.requeteId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requeteId);
  next();
}

/**
 * Réserve la route aux rôles donnés (comptes actifs, rôle vérifié côté serveur).
 * Tout autre rôle reçoit un 403 et le refus est journalisé. À placer après authentifier.
 */
function exigerRolesCliniques(roles, message) {
  return async (req, res, next) => {
    if (roles.includes(req.soignant?.role)) return next();
    await journaliser(req, {
      action: 'acces.refuse',
      resultat: 'refusé',
      ressource: { type: req.baseUrl.replace('/api/', ''), id: null },
      // Chemin demandé (identifiants seulement, jamais de corps de requête).
      details: { role: req.soignant?.role ?? null, chemin: req.path },
    });
    res.status(403).json({ message });
  };
}

/** Dossier médical : réservé aux médecins (infirmier·ères et sages-femmes refusé·es). */
const exigerMedecin = exigerRolesCliniques(ROLES_MEDECIN, 'Le dossier médical est réservé aux médecins.');

/** Salle de travail, accouchement et naissance : médecins et sages-femmes. */
const exigerMaternite = exigerRolesCliniques(ROLES_MATERNITE, 'Le dossier d’accouchement est réservé aux médecins et aux sages-femmes.');

module.exports = { identifierRequete, exigerMedecin, exigerMaternite };
